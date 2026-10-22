// Debugger integration (FEATURES.md §4.4): debug type `voxelcore`, run inline
// in the extension host (`DebugAdapterInlineImplementation`).
import * as cp from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { LogResolver } from "../../shared/log/resolve";
import { markDebuggerReady } from "../hotreload/bridge";
import { prepareEngine, hotReloadEnabled, startEngineSession, type VoxelCoreTaskDefinition } from "../run";
import { workspaceIndex } from "../workspaceIndex";
import { engineChannels } from "./channels";
import { EngineHandle, LaunchArguments, SessionHost, VoxelCoreDebugSession } from "./session";
import { VcDbgClient, freePort } from "./vcdbg";

export const DEBUG_TYPE = "voxelcore";

class InlineAdapter implements vscode.DebugAdapter {
    private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.emitter.event;
    private readonly session: VoxelCoreDebugSession;

    constructor(host: SessionHost) {
        this.session = new VoxelCoreDebugSession(host, (m) => this.emitter.fire(m as vscode.DebugProtocolMessage));
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        void this.session.handleMessage(message as Record<string, unknown>);
    }

    dispose() {
        this.emitter.dispose();
    }
}

/** Engine side of one debug session. */
class Host implements SessionHost {
    private resolver = () => new LogResolver(workspaceIndex.get(), { userDir: this.userDir, script: this.script });
    private userDir?: string;
    private script?: string;

    toVirtual(file: string) {
        return this.resolver().virtualPath(file);
    }

    toFile(vpath: string) {
        return this.resolver().resolveVirtual(vpath);
    }

    async launch(args: LaunchArguments, output: (text: string) => void): Promise<EngineHandle> {
        const mode = args.mode ?? "quickWorld";
        const def: VoxelCoreTaskDefinition = {
            type: "voxelcore", action: mode, world: args.world, generator: args.generator, seed: args.seed,
            recreate: args.recreate, script: args.script, args: args.args,
        };
        const port = args.port ?? (await freePort());
        const wait = mode === "quickWorld" && args.waitForDebugger !== false;
        const prepared = await prepareEngine(def, { debugPort: port, bridge: hotReloadEnabled(), waitForDebugger: wait });
        if (!prepared) throw new Error("The VoxelCore engine isn't configured (voxelcore.executable)");
        this.userDir = prepared.userDir;
        this.script = prepared.script;
        output(`> ${prepared.executable} ${prepared.args.join(" ")}\n`);
        const log = startEngineSession(prepared);
        const child = cp.spawn(prepared.executable, prepared.args, { cwd: path.dirname(prepared.executable) });
        const onData = (data: Buffer) => {
            const text = data.toString();
            output(text);
            log.feed(text);
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        const exited = new Promise<number | null>((resolve) => {
            child.on("exit", (code) => {
                log.end();
                resolve(code);
            });
            child.on("error", (err) => {
                output(`failed to start: ${err.message}\n`);
                log.end();
                resolve(1);
            });
        });
        const isAlive = () => child.exitCode === null && !child.killed;
        const client = await VcDbgClient.connect(port, { isAlive, disconnectAction: "terminate" });
        const channel = engineChannels.add(
            { port, userDir: prepared.userDir, bridge: prepared.bridge, label: `debug: ${mode}`, client },
            "debugger"
        );
        return {
            port,
            client,
            isAlive,
            exited,
            kill: () => child.kill(),
            configured: (messages) => {
                if (wait) markDebuggerReady(prepared.userDir, messages);
            },
            release: (c) => c === channel.client && engineChannels.release(c),
        };
    }

    async attach(args: LaunchArguments): Promise<EngineHandle> {
        // a run started by the extension: take its connection over
        const running = args.port ? engineChannels.byPort(args.port) : engineChannels.current();
        if (running) {
            if (running.owner === "debugger") throw new Error(`A debugger is already attached to the engine on port ${running.port}`);
            engineChannels.adopt(running);
            this.userDir = running.userDir;
            return {
                port: running.port,
                client: running.client,
                isAlive: () => !running.client.isClosed,
                release: (c) => engineChannels.release(c),
            };
        }
        if (!args.port) throw new Error("No running engine: start one (VoxelCore: Run Quick World) or set 'port' in launch.json");
        const client = await VcDbgClient.connect(args.port, { host: args.host, disconnectAction: "resume", timeoutMs: 5000 });
        return { port: args.port, host: args.host, client, isAlive: () => !client.isClosed };
    }
}

const QUICK_WORLD: vscode.DebugConfiguration = {
    type: DEBUG_TYPE,
    request: "launch",
    name: "VoxelCore: Debug Quick World",
    mode: "quickWorld",
};

export function registerDebug(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
            createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new InlineAdapter(new Host())),
        }),
        vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
            provideDebugConfigurations: () => [
                QUICK_WORLD,
                { type: DEBUG_TYPE, request: "attach", name: "VoxelCore: Attach to Running Engine" },
            ],
            resolveDebugConfiguration: (_folder, config) => {
                // F5 without launch.json
                if (!config.type && !config.request && !config.name) return { ...QUICK_WORLD };
                return config;
            },
        }),
        vscode.commands.registerCommand("voxelcore.debugQuickWorld", () => vscode.debug.startDebugging(undefined, { ...QUICK_WORLD })),
        vscode.commands.registerCommand("voxelcore.attachDebugger", () =>
            vscode.debug.startDebugging(undefined, { type: DEBUG_TYPE, request: "attach", name: "VoxelCore: Attach" })
        ),
        vscode.commands.registerCommand("voxelcore.debugHeadlessScript", async (uri?: vscode.Uri) => {
            const file = uri ?? vscode.window.activeTextEditor?.document.uri;
            if (!file?.fsPath.endsWith(".lua")) {
                vscode.window.showWarningMessage("Open a Lua app script to debug it headless.");
                return;
            }
            await vscode.debug.startDebugging(undefined, {
                type: DEBUG_TYPE, request: "launch", name: `Debug ${path.basename(file.fsPath)}`, mode: "headless", script: file.fsPath,
            });
        })
    );
}
