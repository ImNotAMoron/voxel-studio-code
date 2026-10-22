import * as vscode from "vscode";
import * as path from "node:path";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from "vscode-languageclient/node";
import { registerLua } from "./lua";
import { registerSchemas } from "./schemas";
import { registerPreview } from "./preview";
import { registerScaffold } from "./scaffold";
import { registerRun, setStorageRoot } from "./run";
import { findResPath, findWorkspacePacks } from "./packs";
import { registerLog } from "./log";
import { registerExplorer } from "./explorer";
import { registerWorkspaceIndex } from "./workspaceIndex";
import { registerNavigation } from "./navigation";
import { registerDebug } from "./debug";
import { registerHotReload } from "./hotreload";
import { registerThumbnails } from "./thumbnails";

let client: LanguageClient | undefined;

const HOVER_COMMANDS = ["voxelcore.openFile", "voxelcore.previewFile"];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    if (context.storageUri) setStorageRoot(context.storageUri.fsPath);
    registerWorkspaceIndex(context);
    const log = registerLog(context);
    registerScaffold(context);
    registerRun(context, log);
    registerExplorer(context, log);
    registerDebug(context);
    registerHotReload(context);
    registerPreview(context);
    registerSchemas(context);
    registerLua(context);
    registerNavigation(context, () => client);
    registerThumbnails(context);
    context.subscriptions.push(
        // command links in hovers (server/src/features/assets.ts)
        vscode.commands.registerCommand("voxelcore.openFile", (file: string) => vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file))),
        vscode.commands.registerCommand("voxelcore.previewFile", (file: string) => vscode.commands.executeCommand("voxelcore.openPreview", vscode.Uri.file(file)))
    );
    await updatePackContext();
    context.subscriptions.push(
        vscode.workspace.onDidCreateFiles(() => updatePackContext()),
        vscode.workspace.onDidDeleteFiles(() => updatePackContext())
    );
    await startLanguageServer(context);
}

export async function deactivate(): Promise<void> {
    await client?.stop();
}

/** `voxelcore.hasPacks` context key for menus and views. */
async function updatePackContext() {
    const packs = await findWorkspacePacks();
    await vscode.commands.executeCommand("setContext", "voxelcore.hasPacks", packs.length > 0);
}

function serverSettings() {
    const config = vscode.workspace.getConfiguration("voxelcore");
    return {
        resPath: findResPath(),
        lint: {
            enable: config.get<boolean>("lint.enable", true),
            rules: config.get<Record<string, string>>("lint.rules", {}),
        },
    };
}

async function startLanguageServer(context: vscode.ExtensionContext) {
    const module = context.asAbsolutePath(path.join("dist", "server.js"));
    const serverOptions: ServerOptions = {
        run: { module, transport: TransportKind.ipc },
        debug: { module, transport: TransportKind.ipc, options: { execArgv: ["--nolazy", "--inspect=6019"] } },
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: "file", language: "json" },
            { scheme: "file", language: "jsonc" },
            { scheme: "file", language: "toml" },
            { scheme: "file", language: "lua" },
            { scheme: "file", language: "vcm" },
            { scheme: "file", language: "vca" },
            { scheme: "file", language: "vclang" },
        ],
        synchronize: {
            configurationSection: "voxelcore",
            fileEvents: vscode.workspace.createFileSystemWatcher(
                "**/*.{json,toml,lua,vcm,vca,txt,png,ogg,wav,obj,vec3,xml,vox}"
            ),
        },
        initializationOptions: serverSettings(),
        outputChannelName: "VoxelCore Language Server",
        middleware: {
            provideHover: async (document, position, token, next) => {
                const hover = await next(document, position, token);
                // only the hover's own command links may run
                for (const content of hover?.contents ?? []) {
                    if (content instanceof vscode.MarkdownString) content.isTrusted = { enabledCommands: HOVER_COMMANDS };
                }
                return hover;
            },
            workspace: {
                configuration: async (params, token, next) => {
                    const result = await next(params, token);
                    // resPath is auto-detected on the client side
                    if (Array.isArray(result)) {
                        return result.map((item, i) =>
                            params.items[i]?.section === "voxelcore" ? { ...(item ?? {}), ...serverSettings() } : item
                        );
                    }
                    return result;
                },
            },
        },
    };
    client = new LanguageClient("voxelcore", "VoxelCore Language Server", serverOptions, clientOptions);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore") && client) {
                void client.sendNotification("workspace/didChangeConfiguration", { settings: { voxelcore: serverSettings() } });
            }
        }),
        vscode.commands.registerCommand("voxelcore.restartServer", async () => {
            await client?.restart();
        })
    );
    try {
        await client.start();
    } catch (err) {
        vscode.window.showErrorMessage(`VoxelCore language server failed to start: ${(err as Error).message}`);
    }
}
