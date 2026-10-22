// Content explorer (FEATURES.md §3.10): a VoxelCore view container with the
// Content, Dependencies and Engine tree views, fed by the workspace index.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PackInfo } from "../../shared/content";
import type { EngineLog } from "../log";
import { findExecutable, findResPath } from "../packs";
import { resolveUserDir } from "../run";
import { workspaceIndex } from "../workspaceIndex";
import { engineChannels } from "../debug/channels";
import {
    Locales,
    explorerPacks,
    packCategories,
    packDependencies,
    type ContentCategory,
    type ContentEntry,
    type EntryKind,
} from "./model";

const KIND_ICONS: Record<EntryKind, string> = {
    block: "symbol-constant",
    item: "symbol-field",
    entity: "person",
    skeleton: "type-hierarchy",
    component: "symbol-class",
    generator: "globe",
    model: "symbol-structure",
    texture: "file-media",
    sound: "unmute",
    layout: "layout",
    script: "symbol-method",
    module: "symbol-namespace",
    material: "symbol-color",
};

/** Kinds the model preview can open. */
const PREVIEWABLE = new Set<EntryKind>(["block", "entity", "skeleton"]);
const PREVIEW_MODEL = /\.(vcm|obj|vec3)$/i;

type ContentNode =
    | { type: "pack"; pack: PackInfo }
    | { type: "builtin"; packs: PackInfo[] }
    | { type: "category"; pack: string; category: ContentCategory }
    | { type: "folder"; pack: string; atlas: string; entries: ContentEntry[] }
    | { type: "entry"; entry: ContentEntry };

class ContentProvider implements vscode.TreeDataProvider<ContentNode> {
    private readonly changed = new vscode.EventEmitter<ContentNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;
    private locales: Locales | undefined;

    refresh() {
        this.locales = undefined;
        this.changed.fire(undefined);
    }

    private getLocales(): Locales {
        this.locales ??= new Locales(workspaceIndex.get(), vscode.env.language);
        return this.locales;
    }

    getChildren(node?: ContentNode): ContentNode[] {
        const index = workspaceIndex.get();
        if (!node) {
            const { workspace, builtin } = explorerPacks(index);
            const nodes: ContentNode[] = workspace.map((pack) => ({ type: "pack", pack }));
            if (builtin.length) nodes.push({ type: "builtin", packs: builtin });
            return workspace.length ? nodes : [];
        }
        switch (node.type) {
            case "builtin":
                return node.packs.map((pack) => ({ type: "pack", pack }));
            case "pack":
                return packCategories(index, node.pack.id, this.getLocales()).map((category) => ({ type: "category", pack: node.pack.id, category }));
            case "category":
                if (node.category.folders && node.category.folders.size > 1) {
                    return [...node.category.folders].map(([atlas, entries]) => ({ type: "folder", pack: node.pack, atlas, entries }));
                }
                return node.category.entries.map((entry) => ({ type: "entry", entry }));
            case "folder":
                return node.entries.map((entry) => ({ type: "entry", entry }));
            case "entry":
                return [];
        }
    }

    getTreeItem(node: ContentNode): vscode.TreeItem {
        const C = vscode.TreeItemCollapsibleState;
        switch (node.type) {
            case "builtin": {
                const item = new vscode.TreeItem("Built-in packs", C.Collapsed);
                item.iconPath = new vscode.ThemeIcon("library");
                item.description = node.packs.map((p) => p.id).join(", ");
                return item;
            }
            case "pack": {
                const p = node.pack;
                const item = new vscode.TreeItem(p.id, p.builtin ? C.Collapsed : C.Expanded);
                item.id = `pack:${p.id}`;
                item.description = [p.title, p.version].filter(Boolean).join(" · ");
                item.tooltip = new vscode.MarkdownString(`**${p.title ?? p.id}** \`${p.id}\`${p.version ? ` ${p.version}` : ""}\n\n${p.root}`);
                item.iconPath = new vscode.ThemeIcon(p.builtin ? "package" : "folder-library");
                item.resourceUri = vscode.Uri.file(p.root);
                item.contextValue = "voxelcore.pack";
                if (p.packageFile) item.command = { command: "vscode.open", title: "Open package.json", arguments: [vscode.Uri.file(p.packageFile)] };
                return item;
            }
            case "category": {
                const item = new vscode.TreeItem(node.category.label, C.Collapsed);
                item.id = `cat:${node.pack}:${node.category.key}`;
                item.description = String(node.category.entries.length);
                return item;
            }
            case "folder": {
                const item = new vscode.TreeItem(node.atlas || "(root)", C.Collapsed);
                item.id = `atlas:${node.pack}:${node.atlas}`;
                item.iconPath = vscode.ThemeIcon.Folder;
                item.description = String(node.entries.length);
                return item;
            }
            case "entry":
                return entryItem(node.entry);
        }
    }
}

function entryItem(entry: ContentEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
    item.id = `${entry.kind}:${entry.id ?? entry.file ?? entry.label}`;
    item.description = entry.description;
    item.iconPath = entry.icon ? vscode.Uri.file(entry.icon) : new vscode.ThemeIcon(KIND_ICONS[entry.kind]);
    const lines = [entry.id ? `\`${entry.id}\`` : undefined, entry.description, entry.file].filter(Boolean);
    item.tooltip = new vscode.MarkdownString(lines.join("\n\n"));
    if (entry.icon) item.tooltip.appendMarkdown(`\n\n![](${vscode.Uri.file(entry.icon).toString()}|width=64)`);
    const flags = [entry.id ? "id" : "", entry.file ? "file" : "", isPreviewable(entry) ? "previewable" : ""].filter(Boolean);
    item.contextValue = `voxelcore.entry ${flags.join(" ")}`;
    if (entry.file) item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(entry.file)] };
    return item;
}

function isPreviewable(entry: ContentEntry): boolean {
    return !!entry.file && (PREVIEWABLE.has(entry.kind) || (entry.kind === "model" && PREVIEW_MODEL.test(entry.file)));
}

// ---- dependencies ----

type DepNode =
    | { type: "pack"; pack: PackInfo }
    | { type: "dep"; label: string; description: string; status: string; file?: string; tooltip: string }
    | { type: "order"; order: string[]; error?: string };

const STATUS_ICONS: Record<string, [string, string?]> = {
    ok: ["check", "testing.iconPassed"],
    missing: ["error", "errorForeground"],
    version: ["warning", "problemsWarningIcon.foreground"],
    ignored: ["circle-slash", "disabledForeground"],
};

class DependenciesProvider implements vscode.TreeDataProvider<DepNode> {
    private readonly changed = new vscode.EventEmitter<DepNode | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    refresh() {
        this.changed.fire(undefined);
    }

    getChildren(node?: DepNode): DepNode[] {
        const index = workspaceIndex.get();
        if (!node) return explorerPacks(index).workspace.map((pack) => ({ type: "pack", pack }));
        if (node.type !== "pack") return [];
        const info = packDependencies(index, node.pack);
        const rows: DepNode[] = info.dependencies.map((d) => ({
            type: "dep",
            label: d.id,
            description: `${d.level}${d.version !== "*" ? ` ${d.version}` : ""}${d.actual ? ` · found ${d.actual}` : d.status === "ignored" ? " · not installed" : ""}`,
            status: d.status,
            file: d.file,
            tooltip: `"${d.raw}": ${d.status === "ok" ? "satisfied" : d.status === "missing" ? "required pack not found (the engine refuses to load)" : d.status === "version" ? "version not satisfied (the engine refuses to load)" : "not installed (optional/weak: skipped)"}`,
        }));
        rows.push({ type: "order", order: info.order, error: info.error });
        return rows;
    }

    getTreeItem(node: DepNode): vscode.TreeItem {
        if (node.type === "pack") {
            const info = packDependencies(workspaceIndex.get(), node.pack);
            const item = new vscode.TreeItem(node.pack.id, vscode.TreeItemCollapsibleState.Expanded);
            item.id = `deps:${node.pack.id}`;
            item.description = info.error ? "cannot load" : `${info.dependencies.length} dependencies`;
            item.iconPath = info.error ? new vscode.ThemeIcon("error", new vscode.ThemeColor("errorForeground")) : new vscode.ThemeIcon("folder-library");
            if (node.pack.packageFile) item.command = { command: "vscode.open", title: "Open package.json", arguments: [vscode.Uri.file(node.pack.packageFile)] };
            return item;
        }
        if (node.type === "order") {
            const item = new vscode.TreeItem(node.error ? "Load error" : "Load order", vscode.TreeItemCollapsibleState.None);
            item.description = node.error ?? node.order.join(" → ");
            item.tooltip = node.error ? `PacksManager::assemble: ${node.error}` : `Order in which the engine loads the packs:\n${node.order.join("\n")}`;
            item.iconPath = new vscode.ThemeIcon(node.error ? "error" : "list-ordered", node.error ? new vscode.ThemeColor("errorForeground") : undefined);
            return item;
        }
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = node.tooltip;
        const [icon, color] = STATUS_ICONS[node.status] ?? ["circle-outline"];
        item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        if (node.file) item.command = { command: "vscode.open", title: "Open package.json", arguments: [vscode.Uri.file(node.file)] };
        return item;
    }
}

// ---- engine ----

interface EngineRow {
    key: string;
    label: string;
    value?: string;
    path?: string;
    icon: string;
    command?: vscode.Command;
    missing?: boolean;
}

class EngineProvider implements vscode.TreeDataProvider<EngineRow> {
    private readonly changed = new vscode.EventEmitter<EngineRow | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly log: EngineLog) {}

    refresh() {
        this.changed.fire(undefined);
    }

    getChildren(row?: EngineRow): EngineRow[] {
        if (row) return [];
        const exe = findExecutable();
        const res = findResPath();
        const userDir = resolveUserDir(false);
        const logFile = path.join(userDir, "latest.log");
        const running = this.log.runningEngines;
        return [
            {
                key: "status",
                label: "Status",
                value: running ? `running (${running})` : "not running",
                icon: running ? "debug-start" : "debug-stop",
            },
            ...this.connectionRows(),
            {
                key: "exe",
                label: "Executable",
                value: exe && fs.existsSync(exe) ? exe : "not found: set voxelcore.executable",
                path: exe,
                icon: "file-binary",
                missing: !exe || !fs.existsSync(exe),
                command: exe && fs.existsSync(exe) ? undefined : { command: "workbench.action.openSettings", title: "Settings", arguments: ["voxelcore.executable"] },
            },
            {
                key: "res",
                label: "Resources",
                value: res ?? "not found: set voxelcore.resPath",
                path: res,
                icon: "folder",
                missing: !res,
                command: res ? undefined : { command: "workbench.action.openSettings", title: "Settings", arguments: ["voxelcore.resPath"] },
            },
            { key: "user", label: "User dir", value: userDir, path: userDir, icon: "folder" },
            {
                key: "log",
                label: "Log",
                value: fs.existsSync(logFile) ? "latest.log" : "no latest.log yet",
                path: logFile,
                icon: "output",
                command: { command: "voxelcore.showEngineOutput", title: "Show engine output" },
            },
        ];
    }

    /** VC-DBG connections: hot reload and debugger (src/debug/channels.ts). */
    private connectionRows(): EngineRow[] {
        return engineChannels.all().filter((c) => !c.client.isClosed).map((c) => ({
            key: c.owner === "debugger" ? "debugger" : "hotreload",
            label: c.owner === "debugger" ? "Debugger" : "Hot reload",
            value: `${c.owner === "debugger" ? "attached" : c.bridge ? "on (assets, modules, content)" : "on (assets)"} · ${c.label} · port ${c.port}`,
            icon: c.owner === "debugger" ? "debug" : "flame",
        }));
    }

    getTreeItem(row: EngineRow): vscode.TreeItem {
        const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
        item.id = `engine:${row.key}`;
        item.description = row.value;
        item.tooltip = row.path ?? row.value;
        item.iconPath = new vscode.ThemeIcon(row.icon, row.missing ? new vscode.ThemeColor("errorForeground") : undefined);
        item.contextValue = `voxelcore.engine.${row.key}`;
        item.command = row.command;
        if (row.path && fs.existsSync(row.path)) item.resourceUri = vscode.Uri.file(row.path);
        return item;
    }
}

function entryOf(arg: unknown): ContentEntry | undefined {
    const node = arg as ContentNode | undefined;
    return node && node.type === "entry" ? node.entry : undefined;
}

export function registerExplorer(context: vscode.ExtensionContext, log: EngineLog) {
    const content = new ContentProvider();
    const dependencies = new DependenciesProvider();
    const engine = new EngineProvider(log);
    const refreshEngine = () => engine.refresh();
    engineChannels.on("change", refreshEngine);
    context.subscriptions.push({ dispose: () => engineChannels.off("change", refreshEngine) });
    const refresh = () => {
        content.refresh();
        dependencies.refresh();
        engine.refresh();
    };
    context.subscriptions.push(
        vscode.window.createTreeView("voxelcore.content", { treeDataProvider: content, showCollapseAll: true }),
        vscode.window.registerTreeDataProvider("voxelcore.dependencies", dependencies),
        vscode.window.registerTreeDataProvider("voxelcore.engine", engine),
        workspaceIndex.onDidChange(refresh),
        log.onDidChangeSessions(() => engine.refresh()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore")) engine.refresh();
        }),
        vscode.commands.registerCommand("voxelcore.explorer.refresh", () => {
            workspaceIndex.invalidate();
            engine.refresh();
        }),
        vscode.commands.registerCommand("voxelcore.explorer.copyId", async (arg: unknown) => {
            const entry = entryOf(arg);
            const pack = (arg as ContentNode | undefined)?.type === "pack" ? (arg as { pack: PackInfo }).pack.id : undefined;
            const text = entry?.id ?? pack;
            if (text) await vscode.env.clipboard.writeText(text);
        }),
        vscode.commands.registerCommand("voxelcore.explorer.openPreview", async (arg: unknown) => {
            const entry = entryOf(arg);
            if (entry?.file) await vscode.commands.executeCommand("voxelcore.openPreview", vscode.Uri.file(entry.file));
        }),
        vscode.commands.registerCommand("voxelcore.explorer.reveal", async (arg: unknown) => {
            const node = arg as ContentNode | EngineRow | undefined;
            const file = node && "type" in node ? (node.type === "entry" ? node.entry.file : node.type === "pack" ? node.pack.root : undefined) : node?.path;
            if (file) await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(file));
        }),
        vscode.commands.registerCommand("voxelcore.explorer.revealInOS", async (arg: unknown) => {
            const row = arg as EngineRow | undefined;
            if (row?.path) await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(row.path));
        }),
        // internal, used by the smoke test
        vscode.commands.registerCommand("voxelcore.explorer.inspect", async () => {
            const packs = content.getChildren();
            const result: Record<string, Record<string, number>> = {};
            for (const node of packs) {
                if (node.type !== "pack") continue;
                const cats = content.getChildren(node);
                result[node.pack.id] = Object.fromEntries(cats.map((c) => (c.type === "category" ? [c.category.key, c.category.entries.length] : ["?", 0])));
            }
            return { packs: result, dependencies: dependencies.getChildren().length, engine: engine.getChildren().map((r) => `${r.label}: ${r.value}`) };
        })
    );
}
