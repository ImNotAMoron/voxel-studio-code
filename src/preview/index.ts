// Previews (FEATURES.md §5): a three.js webview beside .vcm/.obj editors and
// block / entity / skeleton definition JSON (live, selection-synced), and a
// read-only custom editor for .vec3.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { ContentIndex, normalizePath } from "../../shared/content";
import { buildModel, modelFormat, modelTextures, type ModelData, type Span } from "../../shared/models";
import type { HostToWebview, PreviewOptions, PreviewState, RenderStats, WebviewToHost } from "../../shared/models/protocol";
import { highlightSpans } from "../../shared/models/selection";
import { parseVcm, type VcmDocument } from "../../shared/vcm/parser";
import { findResPath } from "../packs";
import { DefResolver, previewKind, type PreviewKind } from "./defs";
import { findPackRoot, resolveTexture, resolveTextures, textureSearchRoots } from "./textures";

const PANEL_VIEW_TYPE = "voxelcore.modelPreview";
const VEC3_VIEW_TYPE = "voxelcore.vec3Preview";
const UPDATE_DELAY = 50;

let textureVersion = 0;

const pathKey = (file: string) => normalizePath(file).toLowerCase();

/** One ContentIndex for all definition previews (parents, models, skeletons). */
class PreviewIndex {
    private index: ContentIndex | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    get(): ContentIndex {
        if (!this.index) {
            this.index = new ContentIndex({
                resPath: findResPath(),
                roots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
            });
        }
        return this.index;
    }

    /** A file was created/deleted/renamed: rescan lazily. */
    invalidate(onDone: () => void) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.index = undefined;
            onDone();
        }, 300);
    }

    dispose() {
        clearTimeout(this.timer);
    }
}

const previewIndex = new PreviewIndex();

/** Live text of an open document (definition previews read parents with it). */
function liveText(file: string): string | undefined {
    const k = pathKey(file);
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && pathKey(d.uri.fsPath) === k)?.getText();
}

function kindOf(uri: vscode.Uri): PreviewKind | undefined {
    if (uri.scheme !== "file") return modelFormat(uri.path);
    return previewKind(uri.fsPath, findResPath());
}

const isDefKind = (kind: PreviewKind | undefined): kind is "block" | "entity" | "skeleton" =>
    kind === "block" || kind === "entity" || kind === "skeleton";

const MAX_INLINE_TEXTURE = 1024 * 1024;

/**
 * Textures are inlined as data URIs, so WebGL never depends on the webview
 * resource server's CORS headers. Large files fall back to webview URIs.
 */
function textureUrl(webview: vscode.Webview, file: string): string {
    try {
        if (fs.statSync(file).size <= MAX_INLINE_TEXTURE) {
            return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
        }
    } catch {
        // fall through: let the webview report the missing file
    }
    return webview.asWebviewUri(vscode.Uri.file(file)).toString();
}

function nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

function localRoots(context: vscode.ExtensionContext, file?: vscode.Uri): vscode.Uri[] {
    const roots = [
        vscode.Uri.joinPath(context.extensionUri, "dist"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];
    const resPath = findResPath();
    if (resPath) roots.push(vscode.Uri.file(resPath));
    if (file?.scheme === "file") {
        const pack = findPackRoot(file.fsPath, resPath);
        roots.push(vscode.Uri.file(pack ?? path.dirname(file.fsPath)));
    }
    return roots;
}

function webviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "dist", "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "preview", "preview.css"));
    const n = nonce();
    const csp = [
        "default-src 'none'",
        `img-src ${webview.cspSource} blob: data:`,
        `style-src ${webview.cspSource}`,
        `script-src 'nonce-${n}'`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Model Preview</title>
</head>
<body>
<div id="app"><div id="viewport"></div><div id="sidebar"></div></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}

/** One webview showing one model or definition file (panel or custom editor). */
class ModelView implements vscode.Disposable {
    private ready = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private disposables: vscode.Disposable[] = [];
    private vcm: { version: number; doc: VcmDocument } | undefined;
    private lastHighlight = "";
    private disposed = false;
    readonly format: PreviewKind;
    /** Block variant / rotation picked in the webview. */
    private options: PreviewOptions = {};
    /** Files the last definition build read (path keys). */
    private dependencies = new Set<string>();
    /** Last built model (selection sync, smoke-test inspection). */
    lastModel: ModelData | undefined;
    /** What the webview reported for the last model. */
    rendered: RenderStats | undefined;

    constructor(
        readonly context: vscode.ExtensionContext,
        readonly webview: vscode.Webview,
        readonly uri: vscode.Uri,
        private readonly onDispose: () => void
    ) {
        this.format = kindOf(uri) ?? "vcm";
        webview.options = { enableScripts: true, localResourceRoots: localRoots(context, uri) };
        webview.html = webviewHtml(context, webview);
        this.disposables.push(webview.onDidReceiveMessage((message: WebviewToHost) => this.onMessage(message)));
    }

    private post(message: HostToWebview) {
        if (this.ready && !this.disposed) void this.webview.postMessage(message);
    }

    private onMessage(message: WebviewToHost) {
        switch (message.type) {
            case "ready":
                this.ready = true;
                if (message.options) this.options = { ...message.options };
                void this.update();
                break;
            case "select":
                void this.reveal(message.span.start, message.span.end, message.file);
                break;
            case "options":
                this.options = { ...this.options, ...message.options };
                void this.update();
                break;
            case "rendered":
                this.rendered = message.stats;
                break;
        }
    }

    private textDocument(): vscode.TextDocument | undefined {
        const key = this.uri.toString();
        return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    }

    private async source(): Promise<string | Uint8Array> {
        if (this.format !== "vec3") {
            const doc = this.textDocument() ?? (await vscode.workspace.openTextDocument(this.uri));
            return doc.getText();
        }
        return vscode.workspace.fs.readFile(this.uri);
    }

    /** Debounced rebuild (live typing). */
    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.update(), UPDATE_DELAY);
    }

    /** True when the preview reads `file` (definition parents, skeletons, models). */
    dependsOn(file: string): boolean {
        return this.dependencies.has(pathKey(file));
    }

    private resolveTextureFiles(model: ModelData): Record<string, string> {
        if (this.uri.scheme !== "file") return {};
        const resPath = findResPath();
        if (!isDefKind(this.format)) return resolveTextures(modelTextures(model), this.uri.fsPath, resPath);
        // definitions: the content index's pack lookup order first, then the
        // simple resolver (the file's pack, res/, base)
        const index = previewIndex.get();
        const pack = index.packForFile(this.uri.fsPath)?.id;
        const roots = textureSearchRoots(this.uri.fsPath, resPath);
        const files: Record<string, string> = {};
        for (const name of modelTextures(model)) {
            if (name.includes("$")) continue;
            const file = index.resolveTextureRef(name, pack) ?? resolveTexture(name, roots);
            if (file) files[name] = file;
        }
        return files;
    }

    async update() {
        if (!this.ready || this.disposed) return;
        let model: ModelData;
        try {
            if (isDefKind(this.format)) {
                if (this.uri.scheme !== "file") throw new Error("definition previews need a file on disk");
                const build = new DefResolver(previewIndex.get(), liveText).build(this.format, this.uri.fsPath, this.options);
                model = build.model;
                this.dependencies = new Set(build.dependencies.map(pathKey));
            } else {
                model = buildModel(this.format, await this.source());
            }
        } catch (err) {
            this.post({ type: "error", errors: [{ message: String(err instanceof Error ? err.message : err), severity: "error" }] });
            return;
        }
        this.lastModel = model;
        const files = this.resolveTextureFiles(model);
        const textures: Record<string, string> = {};
        for (const [name, file] of Object.entries(files)) {
            textures[name] = textureUrl(this.webview, file);
        }
        this.post({
            type: "model",
            model,
            textures,
            fileName: path.basename(this.uri.path),
            documentUri: this.uri.toString(),
            textureVersion,
        });
        this.lastHighlight = "";
        this.syncSelection();
    }

    private vcmDocument(doc: vscode.TextDocument): VcmDocument {
        if (!this.vcm || this.vcm.version !== doc.version) {
            this.vcm = { version: doc.version, doc: parseVcm(doc.getText()) };
        }
        return this.vcm.doc;
    }

    /** Spans of the previewed document's primitives under the cursor offsets. */
    private definitionSpans(offsets: number[]): Span[] {
        const spans: Span[] = [];
        for (const prim of this.lastModel?.primitives ?? []) {
            if (prim.file) continue;
            const hit = offsets.some((o) => prim.span.start <= o && o <= prim.span.end);
            if (hit && !spans.some((s) => s.start === prim.span.start && s.end === prim.span.end)) spans.push(prim.span);
        }
        return spans;
    }

    /** Highlights the elements under the cursors of the document's editors. */
    syncSelection(editor?: vscode.TextEditor) {
        if (this.format !== "vcm" && !isDefKind(this.format)) return;
        const key = this.uri.toString();
        editor ??= vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
        if (!editor || editor.document.uri.toString() !== key) return;
        const doc = editor.document;
        const offsets = editor.selections.map((s) => doc.offsetAt(s.active));
        const spans = isDefKind(this.format) ? this.definitionSpans(offsets) : highlightSpans(this.vcmDocument(doc).elements, offsets);
        const signature = JSON.stringify(spans);
        if (signature === this.lastHighlight) return;
        this.lastHighlight = signature;
        this.post({ type: "highlight", spans });
    }

    private async reveal(start: number, end: number, file?: string) {
        if (this.format === "vec3") return;
        const target = file ? vscode.Uri.file(file) : this.uri;
        const key = target.toString();
        let editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
        if (!editor) {
            const doc = await vscode.workspace.openTextDocument(target);
            editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
        } else {
            editor = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn });
        }
        const doc = editor.document;
        const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        clearTimeout(this.timer);
        for (const d of this.disposables) d.dispose();
        this.onDispose();
    }
}

class PreviewManager implements vscode.CustomReadonlyEditorProvider {
    private panels = new Map<string, { panel: vscode.WebviewPanel; view: ModelView }>();
    private views = new Set<ModelView>();

    constructor(readonly context: vscode.ExtensionContext) {}

    private track(view: ModelView) {
        this.views.add(view);
    }

    /** Opens (or reveals) the preview panel for a model or definition document. */
    async open(uri: vscode.Uri) {
        const format = kindOf(uri);
        if (format === "vec3") {
            await vscode.commands.executeCommand("vscode.openWith", uri, VEC3_VIEW_TYPE, vscode.ViewColumn.Beside);
            return;
        }
        if (!format) {
            void vscode.window.showWarningMessage(
                `VoxelCore: ${path.basename(uri.path)} is not a .vcm/.obj/.vec3 model or a block, entity or skeleton definition`
            );
            return;
        }
        const existing = this.panels.get(uri.toString());
        if (existing) {
            existing.panel.reveal(vscode.ViewColumn.Beside, true);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            PANEL_VIEW_TYPE,
            `Preview ${path.basename(uri.path)}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: localRoots(this.context, uri) }
        );
        this.attach(panel, uri);
    }

    attach(panel: vscode.WebviewPanel, uri: vscode.Uri) {
        const key = uri.toString();
        panel.title = `Preview ${path.basename(uri.path)}`;
        const view = new ModelView(this.context, panel.webview, uri, () => {
            this.views.delete(view);
            if (this.panels.get(key)?.view === view) this.panels.delete(key);
        });
        this.panels.set(key, { panel, view });
        this.track(view);
        panel.onDidDispose(() => view.dispose());
    }

    // --- CustomReadonlyEditorProvider (.vec3) ---

    openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
        return { uri, dispose: () => undefined };
    }

    resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
        const view = new ModelView(this.context, panel.webview, document.uri, () => this.views.delete(view));
        this.track(view);
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, ".."), path.basename(document.uri.path))
        );
        watcher.onDidChange(() => view.schedule());
        watcher.onDidCreate(() => view.schedule());
        panel.onDidDispose(() => {
            watcher.dispose();
            view.dispose();
        });
    }

    // --- events ---

    viewsFor(uri: vscode.Uri): ModelView[] {
        const key = uri.toString();
        return [...this.views].filter((v) => v.uri.toString() === key);
    }

    /** Views showing `uri` or reading it (definition dependencies). */
    viewsAffectedBy(uri: vscode.Uri): ModelView[] {
        const key = uri.toString();
        return [...this.views].filter((v) => v.uri.toString() === key || (uri.scheme === "file" && v.dependsOn(uri.fsPath)));
    }

    /** Summaries for tests (`voxelcore.preview.inspect`). */
    inspect() {
        return [...this.views].map((v) => ({
            uri: v.uri.toString(),
            kind: v.format,
            info: v.lastModel?.info ?? [],
            errors: (v.lastModel?.errors ?? []).map((e) => `${e.severity}: ${e.message}`),
            parts: v.lastModel?.parts.map((p) => p.name) ?? [],
            triangles: v.lastModel?.parts.reduce((s, p) => s + p.meshes.reduce((t, m) => t + m.positions.length / 9, 0), 0) ?? 0,
            overlays: v.lastModel?.overlays ? v.lastModel.overlays.boxes.length + v.lastModel.overlays.spheres.length : 0,
            rendered: v.rendered,
        }));
    }

    refreshAll() {
        for (const view of this.views) view.schedule();
    }

    dispose() {
        for (const view of [...this.views]) view.dispose();
        for (const { panel } of this.panels.values()) panel.dispose();
    }
}

function activeModelUri(): vscode.Uri | undefined {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && kindOf(doc.uri)) return doc.uri;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (tab instanceof vscode.TabInputCustom || tab instanceof vscode.TabInputText) return tab.uri;
    return undefined;
}

export function registerPreview(context: vscode.ExtensionContext): void {
    const manager = new PreviewManager(context);
    let pngTimer: ReturnType<typeof setTimeout> | undefined;
    const pngWatcher = vscode.workspace.createFileSystemWatcher("**/*.png");
    // definitions, skeletons, models and components changed outside an editor
    const defWatcher = vscode.workspace.createFileSystemWatcher("**/*.{json,vcm,obj,vec3,lua}");
    const onDefChange = (uri: vscode.Uri) => {
        for (const view of manager.viewsAffectedBy(uri)) view.schedule();
    };
    const onDefCreateDelete = () => previewIndex.invalidate(() => manager.refreshAll());
    const updateContext = (editor: vscode.TextEditor | undefined) => {
        const kind = editor ? kindOf(editor.document.uri) : undefined;
        void vscode.commands.executeCommand("setContext", "voxelcore.previewable", isDefKind(kind));
    };
    updateContext(vscode.window.activeTextEditor);
    const onPng = () => {
        clearTimeout(pngTimer);
        pngTimer = setTimeout(() => {
            textureVersion++;
            manager.refreshAll();
        }, 200);
    };

    context.subscriptions.push(
        manager,
        previewIndex,
        pngWatcher,
        defWatcher,
        defWatcher.onDidChange(onDefChange),
        defWatcher.onDidCreate(onDefCreateDelete),
        defWatcher.onDidDelete(onDefCreateDelete),
        vscode.window.onDidChangeActiveTextEditor(updateContext),
        vscode.commands.registerCommand("voxelcore.preview.inspect", () => manager.inspect()),
        pngWatcher.onDidChange(onPng),
        pngWatcher.onDidCreate(onPng),
        pngWatcher.onDidDelete(onPng),
        vscode.commands.registerCommand("voxelcore.openPreview", async (uri?: vscode.Uri) => {
            const target = uri instanceof vscode.Uri ? uri : activeModelUri();
            if (!target) {
                void vscode.window.showInformationMessage("VoxelCore: open a model, block, entity or skeleton file first");
                return;
            }
            await manager.open(target);
        }),
        vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PreviewState | undefined) {
                if (!state?.uri) {
                    panel.dispose();
                    return;
                }
                manager.attach(panel, vscode.Uri.parse(state.uri));
            },
        }),
        vscode.window.registerCustomEditorProvider(VEC3_VIEW_TYPE, manager, {
            webviewOptions: { retainContextWhenHidden: false },
            supportsMultipleEditorsPerDocument: true,
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.contentChanges.length === 0) return;
            for (const view of manager.viewsAffectedBy(e.document.uri)) view.schedule();
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            // obj/vcm files changed outside the editor buffer are covered here
            for (const view of manager.viewsAffectedBy(doc.uri)) view.schedule();
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            // a closed parent/skeleton goes back to its saved text
            for (const view of manager.viewsAffectedBy(doc.uri)) if (view.uri.toString() !== doc.uri.toString()) view.schedule();
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            for (const view of manager.viewsFor(e.textEditor.document.uri)) view.syncSelection(e.textEditor);
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore.resPath")) previewIndex.invalidate(() => manager.refreshAll());
        })
    );
}
