// Workspace content index: packs, units and assets, resolved with the same
// rules the engine uses. Pure Node (fs), no `vscode` import.
//
// Engine references:
// - pack discovery: src/content/ContentPack.cpp (scanFolder, read)
// - unit ids: src/content/ContentLoader.cpp (detect_defs, loadDefs/processName,
//   implicit `<block>.item` items for non-hidden blocks)
// - assets: src/assets/AssetsLoader.cpp, src/assets/assetload_funcs.cpp
// - scripts: ContentLoader::load_script / loadScripts, res/scripts/stdmin.lua (require)

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { sanitizeJson } from "./json";
import { DependencyInfo, MODEL_EXTENSIONS, SOUND_EXTENSIONS, parseDependency } from "./pack";
import { CLIENT_SCRIPT, PROJECT_FILE, ProjectInfo, START_SCRIPT, projectFields } from "./project";

export * from "./pack";
export * from "./project";

export interface PackInfo {
    id: string;
    /** Absolute filesystem path of the pack folder. */
    root: string;
    title?: string;
    version?: string;
    /** Dependency pack ids (any level). */
    dependencies: string[];
    dependencyInfo: DependencyInfo[];
    /** The engine `res/` (core) pack or a pack under `res/content/`. */
    builtin: boolean;
    /** package.json path (undefined for core). */
    packageFile?: string;
    /** package.json `id` was invalid/missing: indexed under the folder name. */
    invalidId?: boolean;
    /** Another pack with the same id wins (this one is not used for resolution). */
    shadowedBy?: string;
}

export type UnitKind = "block" | "item" | "entity";

export interface UnitDef {
    /** Full id `pack:name`. */
    id: string;
    kind: UnitKind;
    /** Pack whose definition files declare it. */
    pack: string;
    /** Short name (file stem). */
    name: string;
    /** Definition file (absent for generated / core units). */
    file?: string;
    /** Parsed JSON (tolerant), when there's a file. */
    json?: Record<string, unknown>;
    /** Implicit block item or core built-in. */
    generated?: boolean;
    /** The block an implicit item belongs to. */
    blockOf?: string;
    /** Additional files that override this unit (`blocks/<pack>/<name>.json` from other packs). */
    overrides: { pack: string; file: string; json?: Record<string, unknown> }[];
}

export interface AssetFile {
    pack: string;
    file: string;
}

export interface GeneratorInfo {
    id: string;
    pack: string;
    name: string;
    file: string;
    filesDir: string;
    script?: string;
    biomesFile?: string;
    structuresFile?: string;
    /** structures.toml names */
    structures: Set<string>;
    /** fragments/*.vox stems */
    fragments: Set<string>;
    biomes: Set<string>;
}

export interface PackData {
    info: PackInfo;
    /** short name -> file, top-level definitions */
    blocks: Map<string, string>;
    items: Map<string, string>;
    entities: Map<string, string>;
    /** files skipped because of a leading `_` */
    skippedDefs: string[];
    materials: Map<string, string>; // full id -> file
    skeletons: Map<string, string>; // full id -> file
    generators: Map<string, GeneratorInfo>; // full id
    textures: Map<string, string>; // "blocks/stone" -> file
    textureAnimations: Map<string, string>; // "blocks/water" -> json file
    models: Map<string, string>; // "player-body" -> file (first by engine ext priority)
    sounds: Map<string, string>; // "steps/stone_0" -> file (without extension in key)
    layouts: Map<string, string>; // stem -> file (top-level layouts/*.xml)
    layoutScripts: Map<string, string>;
    modules: Map<string, string>; // "generation/ores" -> file
    scripts: Map<string, string>; // "stone", "components/drop", "world" -> file
    components: Map<string, string>; // full id -> file
    animations: Map<string, string>; // "anim/name" -> vca file
    locales: Map<string, Map<string, number>>; // lang -> key -> line
    userProps: Map<string, string>; // "pack:prop" -> file
    tags: Map<string, string[]>; // tags.toml: tag -> ids
    preloadFile?: string;
    tagsFile?: string;
    userPropsFile?: string;
    contentFile?: string;
}

export interface IndexOptions {
    /** Engine `res/` folder (core pack + `res/content/*`). */
    resPath?: string;
    /** Workspace folders to scan for packs. */
    roots?: string[];
    /** Explicit pack folders (CLI). */
    packDirs?: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "build", "dist", "out", "fixtures", ".vscode", ".idea", "vcpkg_installed"]);
const CORE_UNITS: [UnitKind, string][] = [
    ["block", "core:air"],
    ["block", "core:obstacle"],
    ["block", "core:struct_air"],
    ["item", "core:empty"],
    ["item", "core:obstacle.item"],
    ["item", "core:struct_air.item"],
];

export function normalizePath(p: string): string {
    return path.resolve(p);
}

function pathKey(p: string): string {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
}

export function isInside(file: string, dir: string): boolean {
    const rel = path.relative(pathKey(dir), pathKey(file));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function readDir(p: string): fs.Dirent[] {
    try {
        return fs.readdirSync(p, { withFileTypes: true });
    } catch {
        return [];
    }
}

function readText(p: string): string | undefined {
    try {
        return fs.readFileSync(p, "utf8");
    } catch {
        return undefined;
    }
}

export function readJsonTolerant(file: string, text?: string): Record<string, unknown> | undefined {
    const src = text ?? readText(file);
    if (src === undefined) return undefined;
    try {
        const value = parseJsonc(sanitizeJson(src), [], { allowTrailingComma: true });
        return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

export function readTomlTolerant(file: string, text?: string): Record<string, unknown> | undefined {
    const src = text ?? readText(file);
    if (src === undefined) return undefined;
    try {
        return parseToml(src) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

/** Recursively lists files under dir as [relative posix path, abs path]. */
function walkFiles(dir: string, out: [string, string][] = [], prefix = ""): [string, string][] {
    for (const entry of readDir(dir)) {
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            walkFiles(abs, out, rel);
        } else if (entry.isFile()) {
            out.push([rel, abs]);
        }
    }
    return out;
}

function stripExt(rel: string): string {
    const dot = rel.lastIndexOf(".");
    const slash = rel.lastIndexOf("/");
    return dot > slash ? rel.slice(0, dot) : rel;
}

/** Finds an engine res folder at or above `start`. */
export function detectResPath(start: string): string | undefined {
    let dir = path.resolve(start);
    for (let i = 0; i < 12; i++) {
        if (isFile(path.join(dir, "res", "content", "base", "package.json"))) {
            return path.join(dir, "res");
        }
        if (isFile(path.join(dir, "content", "base", "package.json")) && isFile(path.join(dir, "scripts", "stdmin.lua"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

/** Reads package.json and returns its id when the file is "pack-shaped". */
function readPackageId(file: string): { json: Record<string, unknown>; id?: string } | undefined {
    const json = readJsonTolerant(file);
    if (!json || !("id" in json)) return undefined;
    return { json, id: typeof json.id === "string" ? json.id : undefined };
}

export class ContentIndex {
    readonly packs = new Map<string, PackInfo>();
    readonly data = new Map<string, PackData>();
    readonly blocks = new Map<string, UnitDef>();
    readonly items = new Map<string, UnitDef>();
    readonly entities = new Map<string, UnitDef>();
    /** Packs hidden by another pack with the same id (still linted). */
    shadowed: PackInfo[] = [];
    /** Projects (folders with a project.toml) in the workspace, plus res/project. */
    readonly projects: ProjectInfo[] = [];
    resPath?: string;
    private roots: string[] = [];
    private packDirs: string[] = [];
    /** Overlay of unsaved document texts (path key -> text). */
    private overlay = new Map<string, string>();

    constructor(options: IndexOptions = {}) {
        this.configure(options);
    }

    configure(options: IndexOptions) {
        this.roots = (options.roots ?? []).map(normalizePath);
        this.packDirs = (options.packDirs ?? []).map(normalizePath);
        this.resPath = options.resPath ? normalizePath(options.resPath) : undefined;
        if (!this.resPath) {
            for (const start of [...this.packDirs, ...this.roots]) {
                const found = detectResPath(start);
                if (found) {
                    this.resPath = found;
                    break;
                }
            }
        }
        this.rebuild();
    }

    /** Full re-scan of pack folders and re-index. */
    rebuild() {
        this.packs.clear();
        this.data.clear();
        this.shadowed = [];
        this.rebuildProjects();
        const folders: { dir: string; builtin: boolean }[] = [];
        const seen = new Set<string>();
        const add = (dir: string, builtin: boolean) => {
            const key = pathKey(dir);
            if (seen.has(key)) return;
            seen.add(key);
            folders.push({ dir, builtin });
        };
        for (const dir of this.packDirs) add(dir, false);
        for (const root of this.roots) {
            for (const dir of this.findPackFolders(root)) add(dir, false);
        }
        if (this.resPath) {
            for (const entry of readDir(path.join(this.resPath, "content"))) {
                if (entry.isDirectory()) add(path.join(this.resPath, "content", entry.name), true);
            }
        }
        // builtin flag also applies to res/content packs found through workspace roots
        for (const folder of folders) {
            if (this.resPath && isInside(folder.dir, this.resPath)) folder.builtin = true;
        }
        if (this.resPath && isDir(this.resPath)) {
            const core: PackInfo = {
                id: "core",
                root: this.resPath,
                title: "Core",
                dependencies: [],
                dependencyInfo: [],
                builtin: true,
            };
            this.packs.set("core", core);
        }
        for (const folder of folders) {
            const info = this.readPack(folder.dir, folder.builtin);
            if (!info) continue;
            const existing = this.packs.get(info.id);
            if (existing) {
                info.shadowedBy = existing.root;
                this.shadowed.push(info);
            } else {
                this.packs.set(info.id, info);
            }
        }
        for (const info of this.packs.values()) {
            this.data.set(info.id, this.indexPack(info));
        }
        this.rebuildUnits();
    }

    private rebuildProjects() {
        this.projects.length = 0;
        const seen = new Set<string>();
        const add = (dir: string, builtin: boolean) => {
            const key = pathKey(dir);
            if (seen.has(key)) return;
            seen.add(key);
            const project = this.readProject(dir, builtin);
            if (project) this.projects.push(project);
        };
        for (const root of this.roots) {
            const visit = (dir: string, depth: number) => {
                if (isFile(path.join(dir, PROJECT_FILE))) add(dir, false);
                // packs don't contain projects
                if (depth >= 8 || isFile(path.join(dir, "package.json")) && readPackageId(path.join(dir, "package.json"))) return;
                for (const entry of readDir(dir)) {
                    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
                    visit(path.join(dir, entry.name), depth + 1);
                }
            };
            visit(root, 0);
        }
        if (this.resPath) add(path.join(this.resPath, "project"), true);
        for (const project of this.projects) {
            if (this.resPath && isInside(project.root, this.resPath)) project.builtin = true;
        }
    }

    private readProject(dir: string, builtin: boolean): ProjectInfo | undefined {
        const file = path.join(dir, PROJECT_FILE);
        if (!isFile(file)) return undefined;
        const root = normalizePath(dir);
        const start = path.join(root, START_SCRIPT);
        const client = path.join(root, CLIENT_SCRIPT);
        return {
            root,
            file: path.join(root, PROJECT_FILE),
            ...projectFields(readTomlTolerant(file, this.text(file))),
            contentDir: path.join(root, "content"),
            startScript: isFile(start) ? start : undefined,
            clientScript: isFile(client) ? client : undefined,
            builtin,
        };
    }

    /** The project whose folder contains `file` (deepest). */
    projectForFile(file: string): ProjectInfo | undefined {
        let best: ProjectInfo | undefined;
        for (const project of this.projects) {
            if (isInside(file, project.root) && (!best || project.root.length > best.root.length)) best = project;
        }
        return best;
    }

    /** project.toml, start.lua or project_client.lua at a project root. */
    projectFile(file: string): { project: ProjectInfo; kind: "toml" | "start" | "client" } | undefined {
        const project = this.projectForFile(file);
        if (!project || pathKey(path.dirname(file)) !== pathKey(project.root)) return undefined;
        const base = path.basename(file);
        const kind = base === PROJECT_FILE ? "toml" : base === START_SCRIPT ? "start" : base === CLIENT_SCRIPT ? "client" : undefined;
        return kind ? { project, kind } : undefined;
    }

    /** The project whose `content/` folder holds the pack. */
    projectOfPack(pack: PackInfo): ProjectInfo | undefined {
        return this.projects.find((p) => isInside(pack.root, p.contentDir) && pathKey(pack.root) !== pathKey(p.contentDir));
    }

    private findPackFolders(root: string): string[] {
        const result: string[] = [];
        const visit = (dir: string, depth: number) => {
            const pkg = path.join(dir, "package.json");
            if (isFile(pkg) && readPackageId(pkg)) {
                result.push(dir);
                return; // packs don't nest
            }
            if (depth >= 8) return;
            for (const entry of readDir(dir)) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
                visit(path.join(dir, entry.name), depth + 1);
            }
        };
        visit(root, 0);
        return result;
    }

    private readPack(dir: string, builtin: boolean): PackInfo | undefined {
        const packageFile = path.join(dir, "package.json");
        const pkg = readPackageId(packageFile);
        if (!pkg) return undefined;
        const json = pkg.json;
        const invalidId = !pkg.id;
        const id = pkg.id ?? path.basename(dir);
        const dependencyInfo: DependencyInfo[] = [];
        if (Array.isArray(json.dependencies)) {
            for (const dep of json.dependencies) {
                if (typeof dep === "string") dependencyInfo.push(parseDependency(dep));
            }
        }
        return {
            id,
            root: normalizePath(dir),
            title: typeof json.title === "string" ? json.title : undefined,
            version: typeof json.version === "string" ? json.version : undefined,
            dependencies: dependencyInfo.map((d) => d.id),
            dependencyInfo,
            builtin,
            packageFile,
            invalidId: invalidId || undefined,
        };
    }

    private text(file: string): string | undefined {
        return this.overlay.get(pathKey(file)) ?? readText(file);
    }

    private indexPack(info: PackInfo): PackData {
        const root = info.root;
        const pd: PackData = {
            info,
            blocks: new Map(),
            items: new Map(),
            entities: new Map(),
            skippedDefs: [],
            materials: new Map(),
            skeletons: new Map(),
            generators: new Map(),
            textures: new Map(),
            textureAnimations: new Map(),
            models: new Map(),
            sounds: new Map(),
            layouts: new Map(),
            layoutScripts: new Map(),
            modules: new Map(),
            scripts: new Map(),
            components: new Map(),
            animations: new Map(),
            locales: new Map(),
            userProps: new Map(),
            tags: new Map(),
        };
        const id = info.id;
        // definitions (detect_defs): top-level files and one level of `<pack>/` override folders
        for (const [folder, map] of [["blocks", pd.blocks], ["items", pd.items], ["entities", pd.entities]] as const) {
            const dir = path.join(root, folder);
            for (const entry of readDir(dir)) {
                const abs = path.join(dir, entry.name);
                if (entry.name.startsWith("_")) {
                    pd.skippedDefs.push(abs);
                    continue;
                }
                if (entry.isFile() && entry.name.endsWith(".json")) {
                    map.set(entry.name.slice(0, -5), abs);
                } else if (entry.isDirectory() && !entry.name.endsWith(".files")) {
                    for (const sub of readDir(abs)) {
                        const subAbs = path.join(abs, sub.name);
                        if (sub.name.startsWith("_")) {
                            pd.skippedDefs.push(subAbs);
                            continue;
                        }
                        if (sub.isFile() && sub.name.endsWith(".json")) {
                            // engine id: `<folder>:<name>` (may override another pack's unit)
                            map.set(`${entry.name}:${sub.name.slice(0, -5)}`, subAbs);
                        }
                    }
                }
            }
        }
        for (const entry of readDir(path.join(root, "block_materials"))) {
            if (entry.isFile() && entry.name.endsWith(".json")) {
                pd.materials.set(`${id}:${entry.name.slice(0, -5)}`, path.join(root, "block_materials", entry.name));
            }
        }
        for (const entry of readDir(path.join(root, "skeletons"))) {
            if (entry.isFile() && entry.name.endsWith(".json")) {
                pd.skeletons.set(`${id}:${entry.name.slice(0, -5)}`, path.join(root, "skeletons", entry.name));
            }
        }
        const genDir = path.join(root, "generators");
        for (const entry of readDir(genDir)) {
            if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
            const name = entry.name.slice(0, -5);
            const filesDir = path.join(genDir, name + ".files");
            const gen: GeneratorInfo = {
                id: `${id}:${name}`,
                pack: id,
                name,
                file: path.join(genDir, entry.name),
                filesDir,
                structures: new Set(),
                fragments: new Set(),
                biomes: new Set(),
            };
            if (isFile(path.join(filesDir, "script.lua"))) gen.script = path.join(filesDir, "script.lua");
            const biomesFile = path.join(filesDir, "biomes.toml");
            if (isFile(biomesFile)) {
                gen.biomesFile = biomesFile;
                for (const key of Object.keys(readTomlTolerant(biomesFile, this.text(biomesFile)) ?? {})) gen.biomes.add(key);
            }
            const structuresFile = path.join(filesDir, "structures.toml");
            if (isFile(structuresFile)) {
                gen.structuresFile = structuresFile;
                for (const key of Object.keys(readTomlTolerant(structuresFile, this.text(structuresFile)) ?? {})) {
                    gen.structures.add(key);
                }
            }
            for (const frag of readDir(path.join(filesDir, "fragments"))) {
                if (frag.isFile() && frag.name.endsWith(".vox")) gen.fragments.add(frag.name.slice(0, -4));
            }
            pd.generators.set(gen.id, gen);
        }
        for (const [rel, abs] of walkFiles(path.join(root, "textures"))) {
            if (rel.endsWith(".png")) pd.textures.set(stripExt(rel), abs);
            else if (rel.endsWith(".json")) pd.textureAnimations.set(stripExt(rel), abs);
        }
        const modelFiles = walkFiles(path.join(root, "models"));
        for (const ext of MODEL_EXTENSIONS) {
            for (const [rel, abs] of modelFiles) {
                if (rel.endsWith(ext) && !pd.models.has(stripExt(rel))) pd.models.set(stripExt(rel), abs);
            }
        }
        for (const [rel, abs] of walkFiles(path.join(root, "sounds"))) {
            if (SOUND_EXTENSIONS.some((e) => rel.endsWith(e))) pd.sounds.set(stripExt(rel), abs);
        }
        for (const entry of readDir(path.join(root, "layouts"))) {
            if (!entry.isFile()) continue;
            if (entry.name.endsWith(".xml")) pd.layouts.set(entry.name.slice(0, -4), path.join(root, "layouts", entry.name));
            else if (entry.name.endsWith(".xml.lua")) {
                pd.layoutScripts.set(entry.name.slice(0, -8), path.join(root, "layouts", entry.name));
            }
        }
        for (const [rel, abs] of walkFiles(path.join(root, "modules"))) {
            if (rel.endsWith(".lua")) pd.modules.set(stripExt(rel), abs);
        }
        for (const [rel, abs] of walkFiles(path.join(root, "scripts"))) {
            if (rel.endsWith(".lua")) pd.scripts.set(stripExt(rel), abs);
        }
        for (const entry of readDir(path.join(root, "scripts", "components"))) {
            if (entry.isFile() && entry.name.endsWith(".lua")) {
                pd.components.set(`${id}:${entry.name.slice(0, -4)}`, path.join(root, "scripts", "components", entry.name));
            }
        }
        for (const [rel, abs] of walkFiles(path.join(root, "animation"))) {
            if (rel.endsWith(".vca")) pd.animations.set(stripExt(rel), abs);
        }
        for (const entry of readDir(path.join(root, "texts"))) {
            if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
            const keys = new Map<string, number>();
            const text = this.text(path.join(root, "texts", entry.name)) ?? "";
            text.split(/\r?\n/).forEach((line, i) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith("#")) return;
                const eq = trimmed.indexOf("=");
                if (eq > 0) keys.set(trimmed.slice(0, eq).trim(), i);
            });
            pd.locales.set(entry.name.slice(0, -4), keys);
        }
        const userPropsFile = path.join(root, "config", "user-props.toml");
        if (isFile(userPropsFile)) {
            pd.userPropsFile = userPropsFile;
            for (const key of Object.keys(readTomlTolerant(userPropsFile, this.text(userPropsFile)) ?? {})) {
                pd.userProps.set(key, userPropsFile);
            }
        }
        const tagsFile = path.join(root, "tags.toml");
        if (isFile(tagsFile)) {
            pd.tagsFile = tagsFile;
            for (const [tag, list] of Object.entries(readTomlTolerant(tagsFile, this.text(tagsFile)) ?? {})) {
                if (Array.isArray(list)) pd.tags.set(tag, list.filter((x): x is string => typeof x === "string"));
            }
        }
        if (isFile(path.join(root, "preload.json"))) pd.preloadFile = path.join(root, "preload.json");
        if (isFile(path.join(root, "content.json"))) pd.contentFile = path.join(root, "content.json");
        return pd;
    }

    private rebuildUnits() {
        this.blocks.clear();
        this.items.clear();
        this.entities.clear();
        for (const [kind, id] of CORE_UNITS) {
            const name = id.slice(5);
            const map = kind === "block" ? this.blocks : this.items;
            map.set(id, { id, kind, pack: "core", name, generated: true, overrides: [] });
        }
        const kinds: [UnitKind, "blocks" | "items" | "entities", Map<string, UnitDef>][] = [
            ["block", "blocks", this.blocks],
            ["item", "items", this.items],
            ["entity", "entities", this.entities],
        ];
        // packs: core first, then others in discovery order (dependency order isn't needed for ids)
        // pass 0: the pack's own units; pass 1: `<pack>/<name>.json` subfolder units (overrides)
        for (const pass of [0, 1])
        for (const pd of this.data.values()) {
            for (const [kind, key, map] of kinds) {
                for (const [shortName, file] of pd[key]) {
                    const colon = shortName.indexOf(":");
                    if ((colon >= 0) !== (pass === 1)) continue;
                    const json = readJsonTolerant(file, this.text(file));
                    const fullId = pass === 1 ? shortName : `${pd.info.id}:${shortName}`;
                    const existing = map.get(fullId);
                    if (existing) {
                        existing.overrides.push({ pack: pd.info.id, file, json });
                        continue;
                    }
                    map.set(fullId, {
                        id: fullId,
                        kind,
                        pack: pd.info.id,
                        name: fullId.slice(fullId.indexOf(":") + 1),
                        file,
                        json,
                        overrides: [],
                    });
                }
            }
        }
        // implicit items for non-hidden blocks
        for (const block of this.blocks.values()) {
            if (block.generated) continue;
            if (this.blockProperty(block, "hidden") === true) continue;
            const itemId = block.id + ".item";
            if (!this.items.has(itemId)) {
                this.items.set(itemId, {
                    id: itemId,
                    kind: "item",
                    pack: block.pack,
                    name: block.name + ".item",
                    generated: true,
                    blockOf: block.id,
                    overrides: [],
                });
            }
        }
    }

    /** Effective property value following overrides and the `parent` chain. */
    blockProperty(unit: UnitDef, key: string, depth = 0): unknown {
        for (let i = unit.overrides.length - 1; i >= 0; i--) {
            const json = unit.overrides[i].json;
            if (json && key in json) return json[key];
        }
        if (unit.json && key in unit.json) return unit.json[key];
        const parent = unit.json?.parent;
        if (typeof parent === "string" && depth < 16) {
            const map = unit.kind === "block" ? this.blocks : unit.kind === "item" ? this.items : this.entities;
            const parentDef = map.get(parent);
            if (parentDef) return this.blockProperty(parentDef, key, depth + 1);
        }
        return undefined;
    }

    // ---- incremental updates ----

    /** Re-index the pack containing `file`. `text` overlays unsaved contents. */
    updateFile(file: string, text?: string) {
        const key = pathKey(file);
        if (text !== undefined) this.overlay.set(key, text);
        if (path.basename(file) === "package.json" || this.projectChange(file)) {
            this.rebuild();
            return;
        }
        const pack = this.packForFile(file);
        if (!pack) return;
        this.data.set(pack.id, this.indexPack(pack));
        this.rebuildUnits();
    }

    /** project.toml edited, or a project script created or deleted: re-scan. */
    private projectChange(file: string): boolean {
        const base = path.basename(file);
        if (base === PROJECT_FILE) return true;
        if (base !== START_SCRIPT && base !== CLIENT_SCRIPT) return false;
        const project = this.projects.find((p) => pathKey(p.root) === pathKey(path.dirname(file)));
        if (!project) return false;
        const known = base === START_SCRIPT ? project.startScript : project.clientScript;
        return !known !== !isFile(file);
    }

    /** Drop the unsaved overlay of a document (closed). */
    clearOverlay(file: string) {
        if (this.overlay.delete(pathKey(file))) this.updateFile(file);
    }

    removeFile(file: string) {
        this.overlay.delete(pathKey(file));
        if (path.basename(file) === "package.json" || this.projectChange(file)) {
            this.rebuild();
            return;
        }
        const pack = this.packForFile(file);
        if (!pack) {
            // a whole pack folder may have been removed
            if ([...this.packs.values()].some((p) => isInside(p.root, file))) this.rebuild();
            return;
        }
        if (!fs.existsSync(pack.root)) {
            this.rebuild();
            return;
        }
        this.data.set(pack.id, this.indexPack(pack));
        this.rebuildUnits();
    }

    // ---- lookup ----

    getPackData(id: string): PackData | undefined {
        return this.data.get(id);
    }

    /** The pack whose folder contains `file` (deepest root; core last). */
    packForFile(file: string): PackInfo | undefined {
        let best: PackInfo | undefined;
        for (const pack of [...this.packs.values(), ...this.shadowed]) {
            if (isInside(file, pack.root) && (!best || pack.root.length > best.root.length)) best = pack;
        }
        return best;
    }

    /** Workspace (non-builtin) packs plus builtin packs found inside workspace roots. */
    lintablePacks(): PackInfo[] {
        return [...this.packs.values(), ...this.shadowed].filter((p) => {
            if (p.id === "core") return false;
            if (this.packDirs.some((d) => pathKey(d) === pathKey(p.root))) return true;
            return this.roots.some((r) => isInside(p.root, r));
        });
    }

    /** Projects inside workspace roots (res/project only when a root contains it). */
    lintableProjects(): ProjectInfo[] {
        return this.projects.filter((p) => this.roots.some((r) => isInside(p.root, r)));
    }

    /** The pack, its (transitive) dependencies and core, in lookup priority order. */
    lookupOrder(fromPack?: string): PackData[] {
        const order: PackData[] = [];
        const seen = new Set<string>();
        const visit = (id: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            const pd = this.data.get(id);
            if (!pd) return;
            order.push(pd);
            for (const dep of pd.info.dependencies) visit(dep);
        };
        if (fromPack) visit(fromPack);
        visit("core");
        // remaining packs: the engine's ResPaths includes every loaded pack
        for (const id of this.data.keys()) visit(id);
        return order;
    }

    getUnit(kind: UnitKind, id: string): UnitDef | undefined {
        return (kind === "block" ? this.blocks : kind === "item" ? this.items : this.entities).get(id);
    }

    /** `textures/<atlas>/<name>.png` (atlas "blocks", "items", "entities/tireman", …). */
    resolveTexture(atlas: string, name: string, fromPack?: string): string | undefined {
        const key = atlas ? `${atlas}/${name}` : name;
        for (const pd of this.lookupOrder(fromPack)) {
            const file = pd.textures.get(key);
            if (file) return file;
        }
        return undefined;
    }

    /** Texture reference as written in models/particles: `atlas:name` or `path/name`. */
    resolveTextureRef(ref: string, fromPack?: string): string | undefined {
        const colon = ref.indexOf(":");
        if (colon >= 0) return this.resolveTexture(ref.slice(0, colon), ref.slice(colon + 1), fromPack);
        return this.resolveTexture("", ref, fromPack);
    }

    /** True when some pack has a `textures/<atlas>/` folder (or the atlas is a built-in one). */
    hasTextureFolder(atlas: string): boolean {
        if (atlas === "blocks" || atlas === "items" || atlas === "particles") return true;
        for (const pd of this.data.values()) {
            for (const key of pd.textures.keys()) {
                if (key.startsWith(atlas + "/")) return true;
            }
        }
        return false;
    }

    textureNames(atlas: string): Set<string> {
        const names = new Set<string>();
        const prefix = atlas + "/";
        for (const pd of this.data.values()) {
            for (const key of pd.textures.keys()) {
                if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) names.add(key.slice(prefix.length));
            }
        }
        return names;
    }

    /** Model by asset name; `name.part` (vec3 sub-model / vcm bone part) falls back to `name`. */
    resolveModel(name: string, fromPack?: string): string | undefined {
        for (const candidate of [name, name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined]) {
            if (!candidate) continue;
            for (const pd of this.lookupOrder(fromPack)) {
                const file = pd.models.get(candidate);
                if (file) return file;
            }
        }
        return undefined;
    }

    /** Sound asset `name`: `sounds/name.ogg` or `sounds/name_0.ogg` (also .wav). */
    resolveSound(name: string, fromPack?: string): string | undefined {
        for (const pd of this.lookupOrder(fromPack)) {
            const file = pd.sounds.get(name) ?? pd.sounds.get(name + "_0");
            if (file) return file;
        }
        return undefined;
    }

    /** All sound asset names (variants folded). */
    soundNames(): Set<string> {
        const names = new Set<string>();
        for (const pd of this.data.values()) {
            for (const key of pd.sounds.keys()) {
                const m = /^(.*)_(\d+)$/.exec(key);
                if (m && (m[2] === "0" || pd.sounds.has(m[1]) || pd.sounds.has(m[1] + "_0"))) names.add(m[1]);
                else names.add(key);
            }
        }
        return names;
    }

    resolveMaterial(id: string): string | undefined {
        const colon = id.indexOf(":");
        if (colon < 0) return undefined;
        return this.data.get(id.slice(0, colon))?.materials.get(id);
    }

    resolveSkeleton(id: string): string | undefined {
        const colon = id.indexOf(":");
        if (colon < 0) return undefined;
        return this.data.get(id.slice(0, colon))?.skeletons.get(id);
    }

    resolveComponent(id: string): string | undefined {
        const colon = id.indexOf(":");
        if (colon < 0) return undefined;
        return this.data.get(id.slice(0, colon))?.components.get(id);
    }

    /** UI layout asset `pack:name` -> `<pack>/layouts/<name>.xml`. */
    resolveLayout(id: string): string | undefined {
        const colon = id.indexOf(":");
        if (colon < 0) return undefined;
        return this.data.get(id.slice(0, colon))?.layouts.get(id.slice(colon + 1));
    }

    resolveGenerator(id: string): GeneratorInfo | undefined {
        const colon = id.indexOf(":");
        if (colon < 0) return undefined;
        return this.data.get(id.slice(0, colon))?.generators.get(id);
    }

    /**
     * `require "pack:path"` / bare `require "path"` (caller's pack) ->
     * `<pack>/modules/<path>.lua`. `res` is an alias of `core`.
     */
    resolveModule(spec: string, fromPack?: string): string | undefined {
        const colon = spec.indexOf(":");
        let pack = colon >= 0 ? spec.slice(0, colon) : fromPack;
        const name = colon >= 0 ? spec.slice(colon + 1) : spec;
        if (pack === "res") pack = "core";
        if (!pack) return undefined;
        return this.data.get(pack)?.modules.get(name);
    }

    /** `<pack>/scripts/<name>.lua` */
    resolveScript(pack: string, name: string): string | undefined {
        return this.data.get(pack)?.scripts.get(name);
    }

    /** Combined user properties of all packs (`file.read_combined_object`). */
    userProps(): Map<string, string> {
        const result = new Map<string, string>();
        for (const pd of this.data.values()) {
            for (const [key, file] of pd.userProps) if (!result.has(key)) result.set(key, file);
        }
        return result;
    }

    /** File defining the unit (first definition), for go-to-definition. */
    unitFile(id: string): string | undefined {
        return this.blocks.get(id)?.file ?? this.items.get(id)?.file ?? this.entities.get(id)?.file
            ?? (id.endsWith(".item") ? this.blocks.get(id.slice(0, -5))?.file : undefined);
    }

    /**
     * Units whose script is `<pack>/scripts/<name>.lua`. Script name defaults
     * to the short unit name; implicit block items use `<block>.item`.
     */
    scriptUsers(pack: string, name: string): UnitDef[] {
        const users: UnitDef[] = [];
        for (const map of [this.blocks, this.items]) {
            for (const unit of map.values()) {
                if (unit.pack !== pack || (unit.generated && !unit.blockOf)) continue;
                if (this.scriptNameOf(unit) === name) users.push(unit);
            }
        }
        return users;
    }

    scriptNameOf(unit: UnitDef): string {
        if (unit.generated && unit.blockOf) return unit.name;
        const explicit = this.blockProperty(unit, "script-name");
        if (typeof explicit === "string") return explicit;
        return unit.name;
    }
}
