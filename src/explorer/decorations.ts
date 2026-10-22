// Marks pack root folders in VS Code's Explorer with a badge and colour. An
// icon theme can only match folders by name, so pack roots (any name, found
// by their package.json) are decorated instead; this works with any theme.
import * as vscode from "vscode";
import type { PackInfo } from "../../shared/content";
import { workspaceIndex } from "../workspaceIndex";
import { folderKey, packRootFolders } from "./model";

class PackFolderDecorations implements vscode.FileDecorationProvider {
    private readonly changed = new vscode.EventEmitter<undefined>();
    readonly onDidChangeFileDecorations = this.changed.event;
    private roots: Map<string, PackInfo> | undefined;

    refresh() {
        this.roots = undefined;
        this.changed.fire(undefined);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== "file" || !vscode.workspace.getConfiguration("voxelcore").get<boolean>("explorer.packBadges", true)) return undefined;
        this.roots ??= packRootFolders(
            workspaceIndex.get(),
            (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)
        );
        const pack = this.roots.get(folderKey(uri.fsPath));
        if (!pack) return undefined;
        const title = pack.title && pack.title !== pack.id ? ` (${pack.title})` : "";
        return new vscode.FileDecoration("VC", `VoxelCore pack ${pack.id}${title}`, new vscode.ThemeColor("voxelcore.packFolderForeground"));
    }

    dispose() {
        this.changed.dispose();
    }
}

export function registerPackDecorations(context: vscode.ExtensionContext) {
    const provider = new PackFolderDecorations();
    context.subscriptions.push(
        provider,
        vscode.window.registerFileDecorationProvider(provider),
        workspaceIndex.onDidChange(() => provider.refresh()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore.explorer.packBadges")) provider.refresh();
        })
    );
}
