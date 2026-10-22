// Running packs in the engine: `voxelcore` task type, run commands, status bar.
import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findExecutable, findResPath, findWorkspacePacks, isBuiltinPack, resolveVariables } from "../packs";
import type { EngineLog } from "../log";
import { engineChannels } from "../debug/channels";
import { VcDbgClient, freePort } from "../debug/vcdbg";
import { clearDebuggerReady } from "../hotreload/bridge";
import { quickWorldScript, syncPackLinks } from "./userdir";

export const TASK_TYPE = "voxelcore";

export interface VoxelCoreTaskDefinition extends vscode.TaskDefinition {
    action: "run" | "quickWorld" | "headless";
    /** quickWorld */
    world?: string;
    generator?: string;
    seed?: string;
    recreate?: boolean;
    /** headless: app script to run */
    script?: string;
    /** extra engine arguments */
    args?: string[];
}

let log: EngineLog;

export function registerRun(context: vscode.ExtensionContext, engineLog: EngineLog): void {
    log = engineLog;
    const watchLog = () => log.watch(resolveUserDir(false));
    watchLog();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore.userDir") || e.affectsConfiguration("voxelcore.log.tail")) watchLog();
        }),
        vscode.tasks.registerTaskProvider(TASK_TYPE, {
            provideTasks: () => [
                createTask({ type: TASK_TYPE, action: "run" }, "Run engine"),
                createTask({ type: TASK_TYPE, action: "quickWorld" }, "Run quick world"),
            ],
            resolveTask: (task) => {
                const def = task.definition as VoxelCoreTaskDefinition;
                return createTask(def, task.name, task.scope);
            },
        }),
        vscode.commands.registerCommand("voxelcore.run", () =>
            vscode.tasks.executeTask(createTask({ type: TASK_TYPE, action: "run" }, "Run engine"))
        ),
        vscode.commands.registerCommand("voxelcore.runQuickWorld", runQuickWorld),
        vscode.commands.registerCommand("voxelcore.runHeadlessScript", runHeadlessScript),
        vscode.commands.registerCommand("voxelcore.prepareUserDir", async () => {
            const env = await resolveEnvironment(true);
            if (env) await linkPacks(env, true);
        }),
        vscode.commands.registerCommand("voxelcore.openLog", async () => {
            const file = path.join(resolveUserDir(false), "latest.log");
            if (!fs.existsSync(file)) {
                vscode.window.showInformationMessage("No latest.log yet. Run the engine first.");
                return;
            }
            await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        })
    );

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    status.text = "$(play) VoxelCore";
    status.tooltip = "Run the engine with the workspace content packs (quick world)";
    status.command = "voxelcore.runQuickWorld";
    context.subscriptions.push(status);
    void findWorkspacePacks().then((packs) => {
        if (packs.length > 0) status.show();
    });
}

interface Environment {
    executable: string;
    resPath: string;
    userDir: string;
    storage: string;
}

let storageRoot: string | undefined;
export function setStorageRoot(dir: string) {
    storageRoot = dir;
}

async function resolveEnvironment(interactive: boolean): Promise<Environment | undefined> {
    const config = vscode.workspace.getConfiguration("voxelcore");
    const executable = findExecutable();
    if (!executable || !fs.existsSync(executable)) {
        if (interactive) {
            const pick = "Select Executable";
            const answer = await vscode.window.showErrorMessage(
                "VoxelCore executable not found. Set 'voxelcore.executable' or build the engine.",
                pick,
                "Open Settings"
            );
            if (answer === pick) {
                const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: "Use this executable" });
                if (files?.[0]) {
                    await config.update("executable", files[0].fsPath, vscode.ConfigurationTarget.Workspace);
                    return resolveEnvironment(interactive);
                }
            } else if (answer) {
                void vscode.commands.executeCommand("workbench.action.openSettings", "voxelcore");
            }
        }
        return undefined;
    }
    const resPath = findResPath() ?? path.join(path.dirname(executable), "res");
    if (!fs.existsSync(resPath)) {
        if (interactive) {
            vscode.window.showErrorMessage(`Engine res/ folder not found (${resPath}). Set 'voxelcore.resPath'.`);
        }
        return undefined;
    }
    const userDir = resolveUserDir(true);
    return { executable, resPath, userDir, storage: storagePath() };
}

function storagePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return storageRoot ?? path.join(folder ?? process.cwd(), ".voxelcore");
}

/** `voxelcore.userDir` or the default one in the workspace storage. */
export function resolveUserDir(create: boolean): string {
    const configured = vscode.workspace.getConfiguration("voxelcore").get<string>("userDir");
    const userDir = configured ? resolveVariables(configured) : path.join(storagePath(), "user");
    if (create) fs.mkdirSync(userDir, { recursive: true });
    return userDir;
}

async function linkPacks(env: Environment, verbose: boolean): Promise<string[]> {
    const packs = (await findWorkspacePacks()).filter((p) => !isBuiltinPack(p, env.resPath));
    const report = syncPackLinks(
        env.userDir,
        packs.map((p) => ({ id: p.id, root: p.root.fsPath }))
    );
    log.channel.info(
        `[packs] user dir ${env.userDir}: linked ${report.linked.join(", ") || "-"}; ` +
            `unchanged ${report.unchanged.join(", ") || "-"}; removed ${report.removed.join(", ") || "-"}`
    );
    if (report.blocked.length > 0) {
        vscode.window.showWarningMessage(
            `VoxelCore: a real folder already exists for ${report.blocked.join(", ")} in ${path.join(env.userDir, "content")}; ` +
                "it was left as is and will be used instead of the workspace pack."
        );
    }
    if (verbose) {
        vscode.window.showInformationMessage(`VoxelCore: ${packs.length} pack(s) available in ${env.userDir}`);
    }
    return packs.map((p) => p.id);
}

function createTask(def: VoxelCoreTaskDefinition, name: string, scope?: vscode.TaskScope | vscode.WorkspaceFolder): vscode.Task {
    const task = new vscode.Task(
        def,
        scope ?? vscode.TaskScope.Workspace,
        name,
        "VoxelCore",
        new vscode.CustomExecution(async (resolved) => new EngineTerminal(resolved as VoxelCoreTaskDefinition))
    );
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
    task.isBackground = def.action !== "headless";
    return task;
}

/** The `--script` argument, if any. */
function scriptOf(args: string[]): string | undefined {
    const i = args.indexOf("--script");
    return i >= 0 ? args[i + 1] : undefined;
}

interface DevOptions {
    /** `--dbg-server tcp:<port>` */
    debugPort?: number;
    /** quickWorld: the app script serves dev bridge requests (hot reload). */
    bridge?: boolean;
    /** quickWorld: the app script waits for the debugger's breakpoints. */
    waitForDebugger?: boolean;
}

async function buildArgs(def: VoxelCoreTaskDefinition, env: Environment, packs: string[], dev: DevOptions = {}): Promise<string[] | undefined> {
    const args = ["--res", env.resPath, "--dir", env.userDir];
    if (dev.debugPort) args.push("--dbg-server", `tcp:${dev.debugPort}`);
    if (def.action === "quickWorld") {
        const script = path.join(env.storage, "scripts", "quick_world.lua");
        fs.mkdirSync(path.dirname(script), { recursive: true });
        fs.writeFileSync(
            script,
            quickWorldScript({
                world: def.world ?? "vscode-dev",
                seed: def.seed ?? "2025",
                generator: def.generator ?? (await defaultGenerator(env)),
                packs,
                recreate: def.recreate ?? false,
                bridge: dev.bridge,
                waitForDebugger: dev.waitForDebugger,
            })
        );
        args.push("--script", script);
    } else if (def.action === "headless") {
        if (!def.script) throw new Error("task 'headless' needs a 'script'");
        args.push("--headless", "--script", resolveVariables(def.script));
    }
    args.push(...(def.args ?? []));
    return args;
}

/** First generator of a workspace pack, else base:demo. */
async function defaultGenerator(env: Environment): Promise<string> {
    const generators = await listGenerators(env);
    return generators.find((g) => !g.startsWith("base:") && !g.startsWith("core:")) ?? "base:demo";
}

async function listGenerators(env: Environment): Promise<string[]> {
    const result: string[] = [];
    const packs = await findWorkspacePacks();
    const roots = new Map<string, string>(packs.map((p) => [p.id, p.root.fsPath]));
    const base = path.join(env.resPath, "content", "base");
    if (!roots.has("base") && fs.existsSync(base)) roots.set("base", base);
    for (const [id, root] of roots) {
        const dir = path.join(root, "generators");
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            if (file.endsWith(".toml") && !file.startsWith("_")) result.push(`${id}:${file.slice(0, -5)}`);
        }
    }
    result.push("core:default");
    return result;
}

async function runQuickWorld() {
    const env = await resolveEnvironment(true);
    if (!env) return;
    const generators = await listGenerators(env);
    const preferred = await defaultGenerator(env);
    const items = generators
        .sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : a.localeCompare(b)))
        .map((g) => ({ label: g }));
    const picked = await vscode.window.showQuickPick(items, { title: "World generator for the dev world" });
    if (!picked) return;
    const mode = await vscode.window.showQuickPick(
        [
            { label: "Open existing dev world", recreate: false },
            { label: "Create a fresh dev world", recreate: true },
        ],
        { title: "Dev world 'vscode-dev'" }
    );
    if (!mode) return;
    await vscode.tasks.executeTask(
        createTask(
            { type: TASK_TYPE, action: "quickWorld", generator: picked.label, recreate: mode.recreate },
            "Run quick world"
        )
    );
}

async function runHeadlessScript(uri?: vscode.Uri) {
    const file = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!file || !file.fsPath.endsWith(".lua")) {
        vscode.window.showWarningMessage("Open a Lua app script to run it headless.");
        return;
    }
    await vscode.tasks.executeTask(
        createTask({ type: TASK_TYPE, action: "headless", script: file.fsPath }, `Headless: ${path.basename(file.fsPath)}`)
    );
}

export interface PreparedEngine {
    executable: string;
    args: string[];
    userDir: string;
    packs: string[];
    /** The app script (`--script`), if any. */
    script?: string;
    /** Dev bridge requests are served (quick world). */
    bridge: boolean;
}

/** Links the packs and builds the command line (tasks and debug launches). */
export async function prepareEngine(def: VoxelCoreTaskDefinition, dev: DevOptions = {}): Promise<PreparedEngine | undefined> {
    const env = await resolveEnvironment(true);
    if (!env) return undefined;
    const packs = await linkPacks(env, false);
    if (dev.waitForDebugger) clearDebuggerReady(env.userDir);
    const args = await buildArgs(def, env, packs, dev);
    if (!args) return undefined;
    return { executable: env.executable, args, userDir: env.userDir, packs, script: scriptOf(args), bridge: def.action === "quickWorld" && !!dev.bridge };
}

export function startEngineSession(prepared: PreparedEngine) {
    return log.startSession({ userDir: prepared.userDir, script: prepared.script });
}

export function hotReloadEnabled(): boolean {
    return vscode.workspace.getConfiguration("voxelcore").get<boolean>("hotReload.enable", true);
}

/** Keeps a VC-DBG connection to a run for hot reload (src/debug/channels.ts). */
async function keepConnection(child: cp.ChildProcess, port: number, prepared: PreparedEngine, label: string) {
    try {
        const client = await VcDbgClient.connect(port, { isAlive: () => child.exitCode === null, disconnectAction: "resume" });
        if (child.exitCode !== null) {
            client.close();
            return;
        }
        engineChannels.add({ port, userDir: prepared.userDir, bridge: prepared.bridge, label, client }, "keeper");
        child.once("exit", () => client.close());
    } catch (err) {
        log.channel.warn(`[hot reload] no debugger connection: ${(err as Error).message}`);
    }
}

/** Pseudoterminal that prepares the user dir and runs the engine. */
class EngineTerminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();
    onDidWrite = this.writeEmitter.event;
    onDidClose = this.closeEmitter.event;
    private process?: cp.ChildProcess;

    constructor(private readonly def: VoxelCoreTaskDefinition) {}

    private write(text: string) {
        this.writeEmitter.fire(text.replace(/\r?\n/g, "\r\n"));
    }

    async open(): Promise<void> {
        try {
            // hot reload (§4.2) talks to the engine over VC-DBG; headless scripts run as they are
            const hot = hotReloadEnabled() && this.def.action !== "headless";
            const debugPort = hot ? await freePort() : undefined;
            const prepared = await prepareEngine(this.def, { debugPort, bridge: hot });
            if (!prepared) {
                this.write("VoxelCore: engine not configured.\n");
                this.closeEmitter.fire(1);
                return;
            }
            const { executable, args, packs } = prepared;
            this.write(`> ${executable} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
            this.write(`  packs: ${packs.join(", ") || "(none)"}\n\n`);
            const session = startEngineSession(prepared);
            const child = cp.spawn(executable, args, { cwd: path.dirname(executable) });
            this.process = child;
            if (debugPort) void keepConnection(child, debugPort, prepared, this.def.action === "quickWorld" ? "quick world" : "engine");
            const onData = (data: Buffer) => {
                const text = data.toString();
                this.write(text);
                session.feed(text);
            };
            child.stdout?.on("data", onData);
            child.stderr?.on("data", onData);
            child.on("error", (err) => {
                session.end();
                this.write(`\nfailed to start: ${err.message}\n`);
                this.closeEmitter.fire(1);
            });
            child.on("exit", (code) => {
                session.end();
                this.write(`\nVoxelCore exited with code ${code ?? "?"}\n`);
                this.closeEmitter.fire(code ?? 0);
            });
        } catch (err) {
            this.write(`VoxelCore: ${(err as Error).message}\n`);
            this.closeEmitter.fire(1);
        }
    }

    close(): void {
        if (this.process && this.process.exitCode === null) this.process.kill();
    }
}
