// Lua API intelligence: points the sumneko.lua language server (LuaLS) at the
// generated `meta/` definitions and sets up runtime/globals for VoxelCore
// content packs. See FEATURES.md §3.2.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import {
    computeLuaSettings,
    IGNORE_DIRS_ENGINE,
    isPackManifest,
    LuaConfigInput,
    mergeLuarc,
    SETTING_KEYS,
} from "./settings";
import { applySchemaSettings } from "../schemas";

const LUA_EXTENSION_ID = "sumneko.lua";
const STATE_CHOICE = "voxelcore.lua.choice"; // workspaceState: "configured" | "declined"
const STATE_INSTALL_ASKED = "voxelcore.lua.installAsked"; // globalState

type ConfigureMode = "ask" | "always" | "never";

interface PackRoot {
    id: string;
    root: string;
}

export function registerLua(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("voxelcore.configureLua", () => configureCommand(context)),
        vscode.commands.registerCommand("voxelcore.writeLuarc", () => writeLuarcCommand(context)),
        vscode.extensions.onDidChange(() => {
            // sumneko.lua may have just been installed
            if (vscode.extensions.getExtension(LUA_EXTENSION_ID)) void autoConfigure(context);
        })
    );
    void autoConfigure(context).catch((err) => {
        console.error("voxelcore: Lua configuration failed", err);
    });
}

function metaPath(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.extensionUri, "meta").fsPath;
}

function configInput(context: vscode.ExtensionContext, engineCheckout: boolean): LuaConfigInput {
    return {
        metaPath: metaPath(context),
        ignoreDir: engineCheckout ? IGNORE_DIRS_ENGINE : [],
    };
}

/** Runs on activation and after extensions change. */
let autoRunning = false;
async function autoConfigure(context: vscode.ExtensionContext): Promise<void> {
    if (autoRunning) return;
    autoRunning = true;
    try {
        const mode = vscode.workspace.getConfiguration("voxelcore").get<ConfigureMode>("configureLua", "ask");
        if (mode === "never") return;
        const packs = await findPackRoots();
        const engine = isEngineCheckout();
        if (packs.length === 0 && !engine) return;
        if (!vscode.extensions.getExtension(LUA_EXTENSION_ID)) {
            await offerInstall(context);
            return;
        }
        const input = configInput(context, engine);
        if (pendingChanges(input).length === 0) return;

        const choice = context.workspaceState.get<string>(STATE_CHOICE);
        if (mode === "always" || choice === "configured") {
            await applyWorkspaceSettings(input);
            await context.workspaceState.update(STATE_CHOICE, "configured");
            void applySchemaSettings(true);
            return;
        }
        if (choice === "declined") return; // ask once per workspace
        const answer = await vscode.window.showInformationMessage(
            "VoxelCore: configure the Lua language server (sumneko.lua) with the engine API definitions for this workspace? " +
                "This writes Lua.* settings (and TOML/pack schema associations) to the workspace settings.",
            "Configure",
            "Always",
            "Never"
        );
        if (answer === "Configure" || answer === "Always") {
            if (answer === "Always") {
                await vscode.workspace
                    .getConfiguration("voxelcore")
                    .update("configureLua", "always", vscode.ConfigurationTarget.Global);
            }
            await applyWorkspaceSettings(input);
            await context.workspaceState.update(STATE_CHOICE, "configured");
            void applySchemaSettings(true);
        } else {
            if (answer === "Never") {
                await vscode.workspace
                    .getConfiguration("voxelcore")
                    .update("configureLua", "never", vscode.ConfigurationTarget.Global);
            }
            await context.workspaceState.update(STATE_CHOICE, "declined");
        }
    } finally {
        autoRunning = false;
    }
}

async function offerInstall(context: vscode.ExtensionContext): Promise<boolean> {
    if (context.globalState.get<boolean>(STATE_INSTALL_ASKED)) return false;
    await context.globalState.update(STATE_INSTALL_ASKED, true);
    return promptInstall();
}

async function promptInstall(): Promise<boolean> {
    const answer = await vscode.window.showInformationMessage(
        "VoxelCore: install the Lua language server extension (sumneko.lua) to get completion and docs for the engine Lua API.",
        "Install",
        "Not now"
    );
    if (answer !== "Install") return false;
    await vscode.commands.executeCommand("workbench.extensions.installExtension", LUA_EXTENSION_ID);
    return true;
}

function snapshot(config: vscode.WorkspaceConfiguration) {
    const ws = <T>(key: string) => config.inspect<T>(key)?.workspaceValue;
    return {
        library: ws<unknown>(SETTING_KEYS.library),
        globals: ws<unknown>(SETTING_KEYS.globals),
        runtimeVersion: ws<unknown>(SETTING_KEYS.runtimeVersion),
        runtimePath: ws<unknown>(SETTING_KEYS.runtimePath),
        ignoreDir: ws<unknown>(SETTING_KEYS.ignoreDir),
    };
}

function pendingChanges(input: LuaConfigInput) {
    return computeLuaSettings(snapshot(vscode.workspace.getConfiguration("Lua")), input).changed;
}

async function applyWorkspaceSettings(input: LuaConfigInput): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders?.length) return false;
    const config = vscode.workspace.getConfiguration("Lua");
    const update = computeLuaSettings(snapshot(config), input);
    for (const key of update.changed) {
        if (key === "changed") continue;
        await config.update(SETTING_KEYS[key], update[key], vscode.ConfigurationTarget.Workspace);
    }
    return update.changed.length > 0;
}

async function configureCommand(context: vscode.ExtensionContext): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showWarningMessage("VoxelCore: open a folder or workspace first.");
        return;
    }
    if (!vscode.extensions.getExtension(LUA_EXTENSION_ID)) {
        await promptInstall();
        return; // onDidChange re-runs configuration after the install
    }
    try {
        const changed = await applyWorkspaceSettings(configInput(context, isEngineCheckout()));
        await context.workspaceState.update(STATE_CHOICE, "configured");
            void applySchemaSettings(true);
        vscode.window.showInformationMessage(
            changed
                ? "VoxelCore: Lua language server configured for this workspace."
                : "VoxelCore: Lua language server is already configured."
        );
    } catch (err) {
        vscode.window.showErrorMessage(`VoxelCore: failed to update Lua settings: ${(err as Error).message}`);
    }
}

async function writeLuarcCommand(context: vscode.ExtensionContext): Promise<void> {
    const packs = await findPackRoots();
    let target: string | undefined;
    if (packs.length === 1) {
        target = packs[0].root;
    } else if (packs.length > 1) {
        const pick = await vscode.window.showQuickPick(
            packs.map((p) => ({ label: p.id, description: vscode.workspace.asRelativePath(p.root), root: p.root })),
            { placeHolder: "Pack root to write .luarc.json into" }
        );
        target = pick?.root;
        if (!target) return;
    } else {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showWarningMessage("VoxelCore: no content pack found in the workspace.");
            return;
        }
        target = folder.uri.fsPath;
    }
    const file = path.join(target, ".luarc.json");
    let existing: unknown = {};
    if (fs.existsSync(file)) {
        const errors: { error: number; offset: number; length: number }[] = [];
        existing = parseJsonc(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
        if (errors.length > 0) {
            vscode.window.showErrorMessage(`VoxelCore: ${file} has syntax errors; fix them first.`);
            return;
        }
    }
    const merged = mergeLuarc(existing, configInput(context, false));
    fs.writeFileSync(file, JSON.stringify(merged, null, 4) + "\n");
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
}

/** Workspace folders with a `package.json` that looks like a content pack. */
async function findPackRoots(): Promise<PackRoot[]> {
    const files = await vscode.workspace.findFiles(
        "**/package.json",
        "{**/node_modules/**,**/.git/**,**/build/**,**/dist/**}",
        500
    );
    const packs: PackRoot[] = [];
    for (const file of files) {
        const dir = path.dirname(file.fsPath);
        try {
            const json = JSON.parse(fs.readFileSync(file.fsPath, "utf8"));
            if (isPackManifest(json, fs.readdirSync(dir))) packs.push({ id: json.id, root: dir });
        } catch {
            // not JSON / unreadable: not a pack
        }
    }
    packs.sort((a, b) => a.id.localeCompare(b.id) || a.root.localeCompare(b.root));
    return packs;
}

/** A workspace folder that is the VoxelCore repo itself (engine sources + res/). */
function isEngineCheckout(): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((f) => {
        const root = f.uri.fsPath;
        return (
            fs.existsSync(path.join(root, "res", "content", "base", "package.json")) &&
            fs.existsSync(path.join(root, "src", "logic", "scripting"))
        );
    });
}
