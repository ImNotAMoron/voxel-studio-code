// Content explorer data (FEATURES.md §3.10), built from the ContentIndex.
// Pure: no `vscode` import, so it is unit-tested.

import { idToCaption } from "../../shared/content/locale";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContentIndex, PackData, PackInfo, ProjectInfo, UnitDef } from "../../shared/content";
import { CLIENT_SCRIPT, PERMISSIONS, PROJECT_FILE, START_SCRIPT } from "../../shared/content/project";
import { isInside } from "../../shared/content/index";
import { assemblePacks, dependencyStatus, type AssemblePack, type DependencyStatus } from "../../shared/content/assemble";

export type EntryKind =
    | "block" | "item" | "entity" | "skeleton" | "component" | "generator"
    | "model" | "texture" | "sound" | "layout" | "script" | "module" | "material";

export interface ContentEntry {
    kind: EntryKind;
    label: string;
    /** Full content id (units, skeletons, components, generators, materials). */
    id?: string;
    file?: string;
    description?: string;
    /** PNG used as the tree icon. */
    icon?: string;
}

export interface ContentCategory {
    key: string;
    label: string;
    entries: ContentEntry[];
    /** Textures are grouped by atlas folder (`blocks`, `items`, `entities/x`). */
    folders?: Map<string, ContentEntry[]>;
}

/** `util::id_to_caption`: the name part with `_` (after leading ones) → space. */
export { idToCaption };

/** Translations of all packs for one language (`texts/<lang>.txt`, merged like langs::load). */
export class Locales {
    private readonly values = new Map<string, string>();

    constructor(index: ContentIndex, lang: string | undefined) {
        if (!lang) return;
        const wanted = lang.replace("-", "_").toLowerCase();
        for (const pd of index.data.values()) {
            const file = [...pd.locales.keys()].find((l) => l.toLowerCase() === wanted)
                ?? [...pd.locales.keys()].find((l) => l.toLowerCase().split("_")[0] === wanted.split("_")[0]);
            if (!file) continue;
            let text: string;
            try {
                text = fs.readFileSync(path.join(pd.info.root, "texts", `${file}.txt`), "utf8");
            } catch {
                continue;
            }
            for (const line of text.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) continue;
                const eq = trimmed.indexOf("=");
                if (eq > 0) this.values.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
            }
        }
    }

    get(key: string): string | undefined {
        return this.values.get(key) ?? this.values.get(key.toLowerCase());
    }
}

export function unitCaption(index: ContentIndex, unit: UnitDef, locales?: Locales): string {
    const source = unit.blockOf ? index.blocks.get(unit.blockOf) ?? unit : unit;
    const explicit = source.kind === "block" ? index.blockProperty(source, "caption") : source.json?.caption;
    const caption = typeof explicit === "string" ? explicit : idToCaption(source.id);
    return locales?.get(caption) ?? caption;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** Texture shown for a block: `texture`, else the top face (+Y) of `texture-faces`. */
export function blockIcon(index: ContentIndex, unit: UnitDef): string | undefined {
    if (index.blockProperty(unit, "model") === "none") return undefined;
    const faces = index.blockProperty(unit, "texture-faces");
    const name = str(index.blockProperty(unit, "texture"))
        ?? (Array.isArray(faces) ? str(faces[3]) ?? str(faces[0]) : undefined);
    return name ? index.resolveTexture("blocks", name, unit.pack) : undefined;
}

/** Item icon (ItemLoader: `icon-type` sprite by default, `icon` = `atlas:name` or a block id). */
export function itemIcon(index: ContentIndex, unit: UnitDef): string | undefined {
    if (unit.blockOf) {
        const block = index.blocks.get(unit.blockOf);
        return block ? blockIcon(index, block) : undefined;
    }
    const type = str(unit.json?.["icon-type"]) ?? "sprite";
    const icon = str(unit.json?.icon);
    if (type === "none" || !icon) return undefined;
    if (type === "block") {
        const block = index.blocks.get(icon);
        return block ? blockIcon(index, block) : undefined;
    }
    return index.resolveTextureRef(icon, unit.pack);
}

const byLabel = (a: ContentEntry, b: ContentEntry) => a.label.localeCompare(b.label);

function units(map: Map<string, UnitDef>, pack: string): UnitDef[] {
    return [...map.values()].filter((u) => u.pack === pack && !u.generated);
}

/** Categories of one pack, empty ones left out. */
export function packCategories(index: ContentIndex, packId: string, locales?: Locales): ContentCategory[] {
    const pd = index.getPackData(packId);
    if (!pd) return [];
    const unitEntry = (unit: UnitDef, icon: string | undefined): ContentEntry => {
        const caption = unitCaption(index, unit, locales);
        return {
            kind: unit.kind,
            label: unit.name,
            id: unit.id,
            file: unit.file,
            description: caption !== unit.name ? caption : undefined,
            icon,
        };
    };
    const files = (kind: EntryKind, map: Map<string, string>, idOf?: (key: string) => string): ContentEntry[] =>
        [...map].map(([key, file]) => {
            const short = idOf ? key.slice(key.indexOf(":") + 1) : key;
            return { kind, label: short, id: idOf?.(key), file };
        });
    const categories: ContentCategory[] = [
        {
            key: "blocks",
            label: "Blocks",
            entries: units(index.blocks, packId).map((u) => unitEntry(u, blockIcon(index, u))),
        },
        {
            key: "items",
            label: "Items",
            entries: units(index.items, packId).map((u) => unitEntry(u, itemIcon(index, u))),
        },
        { key: "entities", label: "Entities", entries: units(index.entities, packId).map((u) => unitEntry(u, undefined)) },
        { key: "skeletons", label: "Skeletons", entries: files("skeleton", pd.skeletons, (k) => k) },
        { key: "components", label: "Components", entries: files("component", pd.components, (k) => k) },
        { key: "materials", label: "Block materials", entries: files("material", pd.materials, (k) => k) },
        {
            key: "generators",
            label: "Generators",
            entries: [...pd.generators.values()].map((g) => ({ kind: "generator" as const, label: g.name, id: g.id, file: g.file })),
        },
        { key: "models", label: "Models", entries: files("model", pd.models) },
        textureCategory(pd),
        { key: "sounds", label: "Sounds", entries: files("sound", pd.sounds) },
        { key: "layouts", label: "Layouts", entries: files("layout", pd.layouts) },
        { key: "scripts", label: "Scripts", entries: files("script", pd.scripts) },
        { key: "modules", label: "Modules", entries: files("module", pd.modules) },
    ];
    for (const c of categories) c.entries.sort(byLabel);
    return categories.filter((c) => c.entries.length > 0);
}

function textureCategory(pd: PackData): ContentCategory {
    const folders = new Map<string, ContentEntry[]>();
    const entries: ContentEntry[] = [];
    for (const [key, file] of pd.textures) {
        const slash = key.lastIndexOf("/");
        const atlas = slash >= 0 ? key.slice(0, slash) : "";
        const entry: ContentEntry = { kind: "texture", label: key.slice(slash + 1), file, icon: file };
        entries.push(entry);
        const list = folders.get(atlas) ?? [];
        list.push(entry);
        folders.set(atlas, list);
    }
    for (const list of folders.values()) list.sort(byLabel);
    return { key: "textures", label: "Textures", entries, folders: new Map([...folders].sort(([a], [b]) => a.localeCompare(b))) };
}

/** Packs to show: workspace packs first, then built-in ones. */
export function explorerPacks(index: ContentIndex): { workspace: PackInfo[]; builtin: PackInfo[] } {
    const workspaceIds = new Set(index.lintablePacks().map((p) => p.id));
    const all = [...index.packs.values()];
    const workspace = all.filter((p) => workspaceIds.has(p.id)).sort((a, b) => a.id.localeCompare(b.id));
    const builtin = all.filter((p) => !workspaceIds.has(p.id)).sort((a, b) => (a.id === "core" ? -1 : b.id === "core" ? 1 : a.id.localeCompare(b.id)));
    return { workspace, builtin };
}

export interface ProjectRow {
    label: string;
    description: string;
    /** "ok" | "missing" (base pack not found, script absent) | "unknown" (permission). */
    status: "ok" | "missing" | "unknown";
    file?: string;
    tooltip: string;
}

export interface ExplorerProject {
    project: ProjectInfo;
    files: ProjectRow[];
    permissions: ProjectRow[];
    basePacks: ProjectRow[];
    /** Packs in `<project>/content`. */
    packs: PackInfo[];
}

/** Workspace projects with their files, permissions, base packs and content packs. */
export function explorerProjects(index: ContentIndex): ExplorerProject[] {
    const resContent = index.resPath ? path.join(index.resPath, "content") : undefined;
    return index.lintableProjects().sort((a, b) => a.root.localeCompare(b.root)).map((project) => {
        const files: ProjectRow[] = [
            { label: PROJECT_FILE, description: project.title ?? project.name ?? "", status: "ok", file: project.file, tooltip: "Project definition (Project::deserialize)" },
            {
                label: START_SCRIPT, description: project.startScript ? "app script" : "not created", status: project.startScript ? "ok" : "missing",
                file: project.startScript, tooltip: "Runs at start-up as a coroutine with `app` (replaced by --script)",
            },
            {
                label: CLIENT_SCRIPT, description: project.clientScript ? "client script" : "not created", status: project.clientScript ? "ok" : "missing",
                file: project.clientScript, tooltip: "Loaded on clients; `on_menu_setup`, `on_level_setup`, … run when screens change",
            },
        ];
        const permissions: ProjectRow[] = project.permissions.map((name) => {
            const info = PERMISSIONS.find((p) => p.name === name);
            return {
                label: name, description: info ? "" : "unknown (ignored)", status: info ? "ok" : "unknown",
                tooltip: info ? `Allows ${info.doc}` : "Not a permission the engine checks",
            };
        });
        const basePacks: ProjectRow[] = project.basePacks.map((id) => {
            const copies = [...index.packs.values(), ...index.shadowed].filter((p) => p.id === id);
            const source = copies.find((p) => isInside(p.root, project.contentDir))
                ?? copies.find((p) => resContent && isInside(p.root, resContent));
            if (source) {
                const where = isInside(source.root, project.contentDir) ? "project content" : "res/content";
                return { label: id, description: where, status: "ok", file: source.packageFile, tooltip: source.root };
            }
            return {
                label: id, description: copies.length ? "outside the content sources" : "not found", status: "missing",
                file: copies[0]?.packageFile, tooltip: "The engine stops at start-up ('pack not found') unless the user content folder has it",
            };
        });
        const packs = [...index.packs.values()].filter((p) => index.projectOfPack(p) === project).sort((a, b) => a.id.localeCompare(b.id));
        return { project, files, permissions, basePacks, packs };
    });
}

/** Path key for comparing folders (Windows paths are case-insensitive). */
export function folderKey(fsPath: string, platform = process.platform): string {
    const resolved = path.resolve(fsPath).replace(/[\\/]+$/, "");
    return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Pack root folders inside the workspace folders, for the Explorer decorations. */
export function packRootFolders(index: ContentIndex, workspaceRoots: string[]): Map<string, PackInfo> {
    const roots = workspaceRoots.map((r) => folderKey(r));
    const result = new Map<string, PackInfo>();
    for (const pack of index.packs.values()) {
        const key = folderKey(pack.root);
        if (roots.some((r) => key === r || key.startsWith(r + path.sep))) result.set(key, pack);
    }
    return result;
}

// ---- dependencies ----

export interface DependencyRow {
    raw: string;
    id: string;
    level: string;
    version: string;
    status: DependencyStatus;
    /** The found pack's version. */
    actual?: string;
    file?: string;
}

export interface PackDependencies {
    pack: PackInfo;
    dependencies: DependencyRow[];
    /** Load order when this pack is enabled (core first, as the engine does). */
    order: string[];
    error?: string;
}

function assembleInput(index: ContentIndex): Map<string, AssemblePack> {
    const packs = new Map<string, AssemblePack>();
    for (const p of index.packs.values()) {
        if (p.id !== "core") packs.set(p.id, { id: p.id, version: p.version, dependencyInfo: p.dependencyInfo });
    }
    return packs;
}

export function packDependencies(index: ContentIndex, pack: PackInfo): PackDependencies {
    const packs = assembleInput(index);
    const dependencies = pack.dependencyInfo.map((dep): DependencyRow => {
        const found = index.packs.get(dep.id);
        return {
            raw: dep.raw,
            id: dep.id,
            level: dep.level,
            version: dep.version === "*" ? "*" : `${dep.op}${dep.version}`,
            status: dependencyStatus(dep, packs),
            actual: found?.version,
            file: found?.packageFile,
        };
    });
    const result = assemblePacks([pack.id], packs);
    return {
        pack,
        dependencies,
        order: ["core", ...result.order],
        error: result.error ? `${result.error.pack}: ${result.error.message}` : undefined,
    };
}
