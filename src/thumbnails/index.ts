// Gutter texture thumbnails in definitions and VCM models (FEATURES.md §3.9).
import * as path from "node:path";
import * as vscode from "vscode";
import { workspaceIndex } from "../workspaceIndex";
import { gutterIcon, textureLines } from "./lines";

const LANGUAGES = new Set(["json", "jsonc", "vcm"]);

export function registerThumbnails(context: vscode.ExtensionContext) {
    const cacheDir = path.join(context.globalStorageUri.fsPath, "thumbnails");
    // one decoration type per icon file (gutterIconPath is per type)
    const types = new Map<string, vscode.TextEditorDecorationType>();
    const typeFor = (icon: string) => {
        let type = types.get(icon);
        if (!type) {
            type = vscode.window.createTextEditorDecorationType({ gutterIconPath: vscode.Uri.file(icon), gutterIconSize: "contain" });
            types.set(icon, type);
        }
        return type;
    };
    const shown = new Map<vscode.TextEditor, Set<vscode.TextEditorDecorationType>>();

    const update = (editor: vscode.TextEditor) => {
        const enabled = vscode.workspace.getConfiguration("voxelcore").get<boolean>("gutterThumbnails", true);
        const doc = editor.document;
        const ranges = new Map<vscode.TextEditorDecorationType, vscode.Range[]>();
        if (enabled && doc.uri.scheme === "file" && LANGUAGES.has(doc.languageId)) {
            const index = workspaceIndex.get();
            if (index.packForFile(doc.uri.fsPath)) {
                for (const [line, texture] of textureLines(index, doc.uri.fsPath, doc.getText())) {
                    const icon = gutterIcon(cacheDir, texture);
                    if (!icon) continue;
                    const type = typeFor(icon);
                    const list = ranges.get(type) ?? [];
                    list.push(new vscode.Range(line, 0, line, 0));
                    ranges.set(type, list);
                }
            }
        }
        const previous = shown.get(editor) ?? new Set();
        for (const type of previous) if (!ranges.has(type)) editor.setDecorations(type, []);
        for (const [type, list] of ranges) editor.setDecorations(type, list);
        shown.set(editor, new Set(ranges.keys()));
    };

    let timer: NodeJS.Timeout | undefined;
    const schedule = (delay = 200) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            for (const editor of vscode.window.visibleTextEditors) update(editor);
        }, delay);
    };
    context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors((visible) => {
            for (const editor of [...shown.keys()]) if (!visible.includes(editor)) shown.delete(editor);
            schedule(0);
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) schedule();
        }),
        workspaceIndex.onDidChange(() => schedule()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore.gutterThumbnails")) schedule(0);
        }),
        // internal, used by the smoke test
        vscode.commands.registerCommand("voxelcore.thumbnails.inspect", (uri: vscode.Uri) => {
            const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
            if (!editor) return [];
            return [...textureLines(workspaceIndex.get(), uri.fsPath, editor.document.getText())].map(([line, file]) => ({ line, file, icon: gutterIcon(cacheDir, file) }));
        }),
        { dispose: () => types.forEach((t) => t.dispose()) }
    );
    schedule(0);
}
