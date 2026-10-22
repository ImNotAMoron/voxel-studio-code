// Client side of §3.5: the code lens command and the explorer's Find References
// and Rename actions (vcls requests voxelcore/symbolReferences, voxelcore/renameSymbol).
import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import type * as lsp from "vscode-languageserver-protocol";

/** A file from a command argument: a Uri (Explorer, editor title) or a content explorer entry. */
function fileOf(arg: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) return arg;
    const node = arg as { type?: string; entry?: { file?: string } } | undefined;
    if (node?.type === "entry" && node.entry?.file) return vscode.Uri.file(node.entry.file);
    return vscode.window.activeTextEditor?.document.uri;
}

interface RenameSymbolResult {
    error?: string;
    name?: string;
    id?: string;
    kind?: string;
    edit?: lsp.WorkspaceEdit;
}

export function registerNavigation(context: vscode.ExtensionContext, getClient: () => LanguageClient | undefined) {
    const showReferences = async (uri: vscode.Uri, position: vscode.Position, locations: vscode.Location[]) => {
        if (!locations.length) {
            vscode.window.showInformationMessage("No VoxelCore references found");
            return;
        }
        await vscode.commands.executeCommand("editor.action.showReferences", uri, position, locations);
    };
    context.subscriptions.push(
        // code lens arguments arrive as LSP JSON
        vscode.commands.registerCommand("voxelcore.showReferences", async (uri: string, position: lsp.Position, locations: lsp.Location[]) => {
            const client = getClient();
            if (!client) return;
            const p2c = client.protocol2CodeConverter;
            await showReferences(p2c.asUri(uri), p2c.asPosition(position), await p2c.asReferences(locations));
        }),
        vscode.commands.registerCommand("voxelcore.findReferences", async (arg: unknown) => {
            const client = getClient();
            const uri = fileOf(arg);
            if (!client || !uri) return;
            const locations = await client.sendRequest<lsp.Location[]>("voxelcore/symbolReferences", { uri: uri.toString() });
            const p2c = client.protocol2CodeConverter;
            await showReferences(uri, new vscode.Position(0, 0), await p2c.asReferences(locations));
        }),
        vscode.commands.registerCommand("voxelcore.renameSymbol", async (arg: unknown) => {
            const client = getClient();
            const uri = fileOf(arg);
            if (!client || !uri) return;
            const info = await client.sendRequest<RenameSymbolResult>("voxelcore/renameSymbol", { uri: uri.toString() });
            if (info.error || !info.name) {
                vscode.window.showWarningMessage(info.error ?? "Nothing to rename");
                return;
            }
            const newName = await vscode.window.showInputBox({
                title: `Rename ${info.kind} ${info.id}`,
                prompt: "New name; files and every reference are updated",
                value: info.name,
                validateInput: (v) => (/^[A-Za-z0-9_-]+$/.test(v) ? undefined : "Use letters, digits, '_' and '-'"),
            });
            if (!newName || newName === info.name) return;
            const result = await client.sendRequest<RenameSymbolResult>("voxelcore/renameSymbol", { uri: uri.toString(), newName });
            if (result.error || !result.edit) {
                vscode.window.showWarningMessage(result.error ?? "Rename failed");
                return;
            }
            const edit = await client.protocol2CodeConverter.asWorkspaceEdit(result.edit);
            // like F2: edited files stay unsaved for review
            await vscode.workspace.applyEdit(edit, { isRefactoring: true });
        })
    );
}
