// Find references, rename, workspace symbols and code lens (FEATURES.md §3.5).
//
// A reference is a string that `resolveRef` maps to a file. A symbol is the
// file a reference resolves to (a definition, texture, model, sound, module…),
// so two strings refer to the same symbol exactly when they resolve to the
// same file. Lookup order and pack shadowing are handled by the resolvers.

import * as fs from "node:fs";
import * as path from "node:path";
import { Node, parseTree } from "jsonc-parser";
import { ContentIndex, PackInfo, UnitDef } from "../../../shared/content/index";
import { sanitizeJson } from "../../../shared/content/json";
import { parseVcm, walkVcm } from "../../../shared/vcm/parser";
import { fileRole, relPath } from "../linter";
import { fileKey } from "../uri";
import { RefKind, jsonRefKind, luaCallKind, nodeToValue, resolveRef } from "./refs";

export interface RefOccurrence {
    kind: RefKind;
    value: string;
    /** Offsets of the string contents (without quotes). */
    start: number;
    end: number;
}

export interface FoundRef extends RefOccurrence {
    file: string;
}

export type SymbolKindName =
    | "block" | "item" | "entity" | "texture" | "model" | "sound" | "skeleton" | "material" | "component"
    | "layout" | "module" | "script";

export interface ContentSymbol {
    kind: SymbolKindName;
    /** How references spell it: `pack:name`, `atlas:name`, `steps/stone`, `pack:path/module`. */
    id: string;
    pack: PackInfo;
    /** The file references resolve to. */
    file: string;
    /** The renameable part: the file stem (last path segment, sound variants folded). */
    name: string;
    unit?: UnitDef;
}

/** A full id `pack:name` (blocks, items, entities): found in any string, not only in known keys. */
const UNIT_ID = /^[\w-]+:[\w.-]+$/;
const NAME = /^[A-Za-z0-9_-]+$/;
const SOUND_VARIANT = /^(.*)_(\d+)$/;

// ---------------------------------------------------------------------------
// extraction

function jsonRefs(role: ReturnType<typeof fileRole>["role"], text: string): RefOccurrence[] {
    const root = parseTree(sanitizeJson(text), [], { allowTrailingComma: true });
    if (!root) return [];
    const json = nodeToValue(root);
    const out: RefOccurrence[] = [];
    const visit = (node: Node, p: (string | number)[]) => {
        if (node.type === "object") {
            for (const prop of node.children ?? []) {
                const [k, v] = prop.children ?? [];
                if (k && v) visit(v, [...p, String(k.value)]);
            }
        } else if (node.type === "array") {
            (node.children ?? []).forEach((child, i) => visit(child, [...p, i]));
        } else if (node.type === "string") {
            const value = String(node.value);
            // escapes would shift offsets; ids never contain them
            if (node.length !== value.length + 2) return;
            // block/item `tags` are tag names, which look like ids
            const kind = jsonRefKind(role, p, json) ?? (UNIT_ID.test(value) && p[0] !== "tags" ? "unit" : undefined);
            if (kind) out.push({ kind, value, start: node.offset + 1, end: node.offset + node.length - 1 });
        }
    };
    visit(root, []);
    return out;
}

function luaRefs(text: string): RefOccurrence[] {
    const out: RefOccurrence[] = [];
    let lineStart = 0;
    for (const line of text.split("\n")) {
        const re = /(["'])((?:\\.|(?!\1).)*?)(\1|$)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
            const value = m[2];
            if (!value || value.includes("\\") || !m[3]) continue;
            const kind = luaCallKind(line.slice(0, m.index)) ?? (UNIT_ID.test(value) ? "unit" : undefined);
            const start = lineStart + m.index + 1;
            if (kind) out.push({ kind, value, start, end: start + value.length });
        }
        lineStart += line.length + 1;
    }
    return out;
}

/** TOML (generators, biomes, structures, tags): full unit ids in string values. */
function tomlRefs(text: string): RefOccurrence[] {
    const out: RefOccurrence[] = [];
    for (const m of text.matchAll(/"([^"\\\n]*)"|'([^'\n]*)'/g)) {
        const value = m[1] ?? m[2];
        // keys (tags.toml tag names, user-props) aren't references
        const after = m.index! + m[0].length;
        if (/^[ \t]*=/.test(text.slice(after, after + 40))) continue;
        if (UNIT_ID.test(value)) out.push({ kind: "unit", value, start: m.index! + 1, end: m.index! + 1 + value.length });
    }
    return out;
}

function vcmRefs(text: string): RefOccurrence[] {
    const out: RefOccurrence[] = [];
    walkVcm(parseVcm(text).elements, (el) => {
        for (const attr of el.attributes) {
            if (attr.name !== "texture" || !attr.value || attr.value.startsWith("$")) continue;
            let { start, end } = attr.valueSpan;
            if (text.slice(start, end) !== attr.value) {
                start++;
                end--;
            }
            if (text.slice(start, end) === attr.value) out.push({ kind: "atlasTexture", value: attr.value, start, end });
        }
    });
    return out;
}

/** All references written in one file. Depends only on its path and text. */
export function extractRefs(index: ContentIndex, file: string, text: string): RefOccurrence[] {
    const ext = path.extname(file).toLowerCase();
    const { role } = fileRole(index, file);
    // generated / pack metadata: dependencies aren't unit references
    if (role === "content" || role === "package") return [];
    if (ext === ".json") return jsonRefs(role, text);
    if (ext === ".lua") return luaRefs(text);
    if (ext === ".toml") return tomlRefs(text);
    if (ext === ".vcm" || ext === ".vca") return vcmRefs(text);
    return [];
}

// ---------------------------------------------------------------------------
// symbols

function stripExt(rel: string): string {
    const ext = path.extname(rel);
    return ext ? rel.slice(0, -ext.length) : rel;
}

function lastSegment(key: string): string {
    return key.slice(key.lastIndexOf("/") + 1);
}

/** The symbol defined by `file` (a definition, asset or module), if any. */
export function symbolOfFile(index: ContentIndex, file: string): ContentSymbol | undefined {
    const pack = index.packForFile(file);
    if (!pack) return undefined;
    const pd = index.getPackData(pack.id);
    if (!pd) return undefined;
    const rel = relPath(pack, file);
    const parts = rel.split("/");
    const ext = path.extname(rel).toLowerCase();
    const sub = stripExt(parts.slice(1).join("/"));
    const make = (kind: SymbolKindName, id: string, target: string | undefined, name: string, unit?: UnitDef) =>
        target ? { kind, id, pack, file: target, name, unit } : undefined;
    switch (parts[0]) {
        case "blocks":
        case "items":
        case "entities": {
            const role = fileRole(index, file).role;
            if (role !== "block" && role !== "item" && role !== "entity") return undefined;
            const name = stripExt(parts[parts.length - 1]);
            // blocks/<pack>/<name>.json overrides another pack's unit
            const id = `${parts.length === 3 ? parts[1] : pack.id}:${name}`;
            const unit = index.getUnit(role, id);
            if (!unit?.file) return undefined;
            return make(role, id, unit.file, name, unit);
        }
        case "textures": {
            if (ext !== ".png" || parts.length < 3) return undefined;
            const atlas = path.posix.dirname(sub);
            const name = lastSegment(sub);
            return make("texture", `${atlas}:${name}`, index.resolveTexture(atlas, name, pack.id), name);
        }
        case "models":
            return make("model", sub, index.resolveModel(sub, pack.id), lastSegment(sub));
        case "sounds": {
            const m = SOUND_VARIANT.exec(sub);
            const folded = m && (m[2] === "0" || pd.sounds.has(m[1]) || pd.sounds.has(m[1] + "_0")) ? m[1] : sub;
            return make("sound", folded, index.resolveSound(folded, pack.id), lastSegment(folded));
        }
        case "skeletons":
            return parts.length === 2 && ext === ".json" ? make("skeleton", `${pack.id}:${sub}`, index.resolveSkeleton(`${pack.id}:${sub}`), sub) : undefined;
        case "block_materials":
            return parts.length === 2 && ext === ".json" ? make("material", `${pack.id}:${sub}`, index.resolveMaterial(`${pack.id}:${sub}`), sub) : undefined;
        case "layouts": {
            if (parts.length !== 2) return undefined;
            const name = rel.endsWith(".xml.lua") ? parts[1].slice(0, -8) : ext === ".xml" ? sub : undefined;
            return name ? make("layout", `${pack.id}:${name}`, index.resolveLayout(`${pack.id}:${name}`), name) : undefined;
        }
        case "modules":
            return ext === ".lua" ? make("module", `${pack.id}:${sub}`, index.resolveModule(sub, pack.id), lastSegment(sub)) : undefined;
        case "scripts": {
            if (ext !== ".lua") return undefined;
            if (parts.length === 3 && parts[1] === "components") {
                const id = `${pack.id}:${stripExt(parts[2])}`;
                return make("component", id, index.resolveComponent(id), stripExt(parts[2]));
            }
            // world/hud/content scripts are found by the engine, not referenced
            if (parts.length !== 2 || ["world", "hud", "content"].includes(sub)) return undefined;
            return make("script", sub, index.resolveScript(pack.id, sub), sub);
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// the reference index

/** Folders that never contain references. */
const SKIP_DIRS = new Set(["node_modules", "sounds", "textures", "fonts", "shaders"]);
const REF_EXTS = new Set([".json", ".toml", ".lua", ".vcm", ".vca"]);
/** The engine res/ folder is huge: only these hold references to content. */
const CORE_DIRS = ["scripts", "modules", "layouts", "models", "preload.json"];

function walkFiles(dir: string, out: string[], depth = 0) {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || depth > 10) continue;
            walkFiles(abs, out, depth + 1);
        } else if (REF_EXTS.has(path.extname(e.name).toLowerCase())) {
            out.push(abs);
        }
    }
}

export interface RenamePlan {
    symbol: ContentSymbol;
    /** Text edits, by file (offsets in the current text). */
    edits: Map<string, { start: number; end: number; newText: string }[]>;
    /** Files to rename, after the text edits. */
    renames: { from: string; to: string }[];
    /** Renaming a block/item/entity changes content indices of worlds. */
    unit: boolean;
}

export class ReferenceIndex {
    private readonly cache = new Map<string, { stamp: string; text?: string; refs: RefOccurrence[] }>();

    /**
     * @param getIndex the current content index (the server replaces it on rebuilds)
     * @param openText live text of documents open in the editor
     */
    constructor(
        private readonly getIndex: () => ContentIndex,
        private readonly openText: (file: string) => string | undefined = () => undefined
    ) {}

    get contentIndex(): ContentIndex {
        return this.getIndex();
    }

    /** Every file of every pack that may contain references. */
    files(): string[] {
        const out: string[] = [];
        for (const pd of this.contentIndex.data.values()) {
            const root = pd.info.root;
            if (pd.info.id === "core" && !pd.info.packageFile) {
                for (const sub of CORE_DIRS) {
                    const p = path.join(root, sub);
                    if (sub.endsWith(".json")) {
                        if (fs.existsSync(p)) out.push(p);
                    } else walkFiles(p, out, 1);
                }
            } else {
                walkFiles(root, out);
            }
        }
        return out;
    }

    /** References written in `file` (cached by modification time, or by text for open documents). */
    refsIn(file: string): RefOccurrence[] {
        const key = fileKey(file);
        const open = this.openText(file);
        const cached = this.cache.get(key);
        if (open !== undefined) {
            if (cached?.text === open) return cached.refs;
            const refs = extractRefs(this.contentIndex, file, open);
            this.cache.set(key, { stamp: "open", text: open, refs });
            return refs;
        }
        let stamp: string;
        try {
            const st = fs.statSync(file);
            stamp = `${st.mtimeMs}:${st.size}`;
        } catch {
            return [];
        }
        if (cached && cached.stamp === stamp) return cached.refs;
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            return [];
        }
        const refs = extractRefs(this.contentIndex, file, text);
        this.cache.set(key, { stamp, refs });
        return refs;
    }

    /** The file a reference resolves to. */
    resolve(file: string, ref: RefOccurrence): string | undefined {
        return resolveRef(this.contentIndex, ref.kind, ref.value, this.contentIndex.packForFile(file)?.id);
    }

    /** The symbol under the cursor: a reference string, else the file's own symbol. */
    symbolAt(file: string, text: string, offset: number): { symbol: ContentSymbol; ref?: RefOccurrence } | undefined {
        const ref = extractRefs(this.contentIndex, file, text).find((r) => offset >= r.start && offset <= r.end);
        if (ref) {
            const target = this.resolve(file, ref);
            const symbol = target ? symbolOfFile(this.contentIndex, target) : undefined;
            return symbol ? { symbol, ref } : undefined;
        }
        const own = symbolOfFile(this.contentIndex, file);
        return own ? { symbol: own } : undefined;
    }

    references(symbol: ContentSymbol): FoundRef[] {
        const target = fileKey(symbol.file);
        const out: FoundRef[] = [];
        for (const file of this.files()) {
            for (const ref of this.refsIn(file)) {
                const resolved = this.resolve(file, ref);
                if (resolved && fileKey(resolved) === target) out.push({ ...ref, file });
            }
        }
        return out;
    }

    /** Range of the renameable name inside a reference (relative to the file). */
    nameRange(ref: RefOccurrence, symbol: ContentSymbol): { start: number; end: number } | undefined {
        const at = namePosition(ref.value, symbol.name);
        return at < 0 ? undefined : { start: ref.start + at, end: ref.start + at + symbol.name.length };
    }

    /** Text edits and file renames for renaming `symbol` to `newName`, or an error message. */
    planRename(symbol: ContentSymbol, newName: string, options: { renameFiles?: boolean } = {}): RenamePlan | string {
        const renameFiles = options.renameFiles !== false;
        if (!NAME.test(newName)) return `'${newName}' is not a valid name: use letters, digits, '_' and '-'`;
        if (newName === symbol.name) return "the name is unchanged";
        if (symbol.pack.builtin) return `${symbol.id} belongs to the built-in pack '${symbol.pack.id}' and can't be renamed`;
        const index = this.contentIndex;
        const users = implicitUsers(index, symbol);
        if (users.length) {
            return `${symbol.id} is the default ${symbol.kind} of ${users.map((u) => u.id).join(", ")}; rename the ${users[0].kind} instead`;
        }
        // a unit takes its default script, layout and skeleton along
        const symbols = [{ symbol, newName }, ...(renameFiles ? linkedSymbols(index, symbol, newName) : [])];
        const renames: { from: string; to: string }[] = [];
        if (renameFiles) {
            for (const s of symbols) {
                for (const r of filesOf(index, s.symbol, s.newName)) {
                    if (!renames.some((x) => fileKey(x.from) === fileKey(r.from))) renames.push(r);
                }
            }
        }
        for (const r of renames) {
            if (fs.existsSync(r.to) && fileKey(r.to) !== fileKey(r.from)) return `${path.basename(r.to)} already exists`;
        }
        const edits = new Map<string, { start: number; end: number; newText: string }[]>();
        const add = (file: string, start: number, end: number, newText: string) => {
            const list = edits.get(file) ?? [];
            if (list.some((e) => e.start === start)) return;
            list.push({ start, end, newText });
            edits.set(file, list);
        };
        for (const s of symbols) {
            for (const ref of this.references(s.symbol)) {
                if (index.packForFile(ref.file)?.builtin) continue;
                const range = this.nameRange(ref, s.symbol);
                if (!range) return `can't rewrite '${ref.value}' in ${path.basename(ref.file)}`;
                add(ref.file, range.start, range.end, s.newName);
            }
        }
        const unit = !!symbol.unit;
        if (unit) {
            // keep the unit's position in content.json: the engine would drop the
            // old name and append the new one, shifting every later index
            const edit = contentJsonEdit(index, symbol, newName);
            if (edit) add(edit.file, edit.start, edit.end, edit.newText);
        }
        return { symbol, edits, renames, unit };
    }

    workspaceSymbols(query: string): ContentSymbol[] {
        const index = this.contentIndex;
        const out: ContentSymbol[] = [];
        const seen = new Set<string>();
        const consider = (file: string | undefined) => {
            if (!file) return;
            const symbol = symbolOfFile(index, file);
            if (!symbol || seen.has(`${symbol.kind} ${symbol.id} ${symbol.pack.id}`)) return;
            seen.add(`${symbol.kind} ${symbol.id} ${symbol.pack.id}`);
            if (symbol.pack.id === "core" && symbol.id.startsWith("core:internal/")) return;
            if (!query || symbol.id.toLowerCase().includes(query.toLowerCase())) out.push(symbol);
        };
        for (const map of [index.blocks, index.items, index.entities]) {
            for (const unit of map.values()) if (!unit.generated) consider(unit.file);
        }
        for (const pd of index.data.values()) {
            const assets = [pd.components, pd.skeletons, pd.materials, pd.models, pd.layouts, pd.modules, pd.sounds];
            for (const map of assets) for (const file of map.values()) consider(file);
            for (const [key, file] of pd.textures) if (/^(blocks|items)\//.test(key)) consider(file);
        }
        return out;
    }
}

/** Offset of `name` in a reference value: the last occurrence delimited like a name. */
export function namePosition(value: string, name: string): number {
    for (let i = value.lastIndexOf(name); i >= 0; i = i === 0 ? -1 : value.lastIndexOf(name, i - 1)) {
        const before = i === 0 ? "" : value[i - 1];
        const after = value[i + name.length] ?? "";
        // `pack:name`, `atlas:name`, `dir/name`, `pack:name.item`, `model.part`
        if ((before === "" || before === ":" || before === "/") && (after === "" || after === ".")) return i;
    }
    return -1;
}

function sibling(file: string, oldStem: string, newStem: string): string {
    return path.join(path.dirname(file), newStem + path.basename(file).slice(oldStem.length));
}

/** Files renamed along with the symbol. */
function filesOf(index: ContentIndex, symbol: ContentSymbol, newName: string): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    const { name } = symbol;
    const add = (from: string | undefined) => {
        if (from && fs.existsSync(from) && !out.some((r) => fileKey(r.from) === fileKey(from))) {
            out.push({ from, to: sibling(from, name, newName) });
        }
    };
    const pd = index.getPackData(symbol.pack.id)!;
    switch (symbol.kind) {
        case "block":
        case "item":
        case "entity":
            add(symbol.unit!.file);
            for (const o of symbol.unit!.overrides) add(o.file);
            break;
        case "texture":
            add(symbol.file);
            add(pd.textureAnimations.get(stripExt(relPath(symbol.pack, symbol.file)).slice("textures/".length)));
            break;
        case "sound":
            for (const [key, file] of pd.sounds) {
                const m = SOUND_VARIANT.exec(key);
                if (key === symbol.id || m?.[1] === symbol.id) add(file);
            }
            break;
        case "layout":
            add(symbol.file);
            add(pd.layoutScripts.get(name));
            break;
        default:
            add(symbol.file);
    }
    return out;
}

const explicit = (index: ContentIndex, unit: UnitDef, key: string) => typeof index.blockProperty(unit, key) === "string";

/**
 * Symbols a unit uses by its own name: the script (`script-name` defaults to
 * the name), the implicit block item's script, the block's `ui-layout` and
 * the entity's `skeleton-name` (both default to the full id;
 * src/voxels/Block.hpp, src/objects/EntityDef.hpp).
 */
function linkedSymbols(index: ContentIndex, symbol: ContentSymbol, newName: string): { symbol: ContentSymbol; newName: string }[] {
    const unit = symbol.unit;
    if (!unit) return [];
    const out: { symbol: ContentSymbol; newName: string }[] = [];
    const link = (file: string | undefined, suffix = "") => {
        const linked = file ? symbolOfFile(index, file) : undefined;
        if (linked && !linked.pack.builtin) out.push({ symbol: linked, newName: newName + suffix });
    };
    if (unit.kind !== "entity" && !explicit(index, unit, "script-name")) link(index.resolveScript(unit.pack, unit.name));
    if (unit.kind === "block") {
        link(index.resolveScript(unit.pack, `${unit.name}.item`), ".item");
        if (!explicit(index, unit, "ui-layout")) link(index.resolveLayout(unit.id));
    }
    if (unit.kind === "entity" && !explicit(index, unit, "skeleton-name")) link(index.resolveSkeleton(unit.id));
    return out;
}

/** Units that use `symbol` by default (no explicit property), so renaming it alone breaks them. */
function implicitUsers(index: ContentIndex, symbol: ContentSymbol): UnitDef[] {
    switch (symbol.kind) {
        case "script":
            return index.scriptUsers(symbol.pack.id, symbol.name).filter((u) => !explicit(index, u, "script-name"));
        case "layout": {
            const block = index.blocks.get(symbol.id);
            return block && !explicit(index, block, "ui-layout") ? [block] : [];
        }
        case "skeleton": {
            const entity = index.entities.get(symbol.id);
            return entity && !explicit(index, entity, "skeleton-name") ? [entity] : [];
        }
        default:
            return [];
    }
}

/** The unit's entry in its pack's content.json. */
function contentJsonEdit(index: ContentIndex, symbol: ContentSymbol, newName: string) {
    const unit = symbol.unit!;
    const owner = index.packs.get(unit.pack);
    if (!owner) return undefined;
    const file = path.join(owner.root, "content.json");
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
    const section = { block: "blocks", item: "items", entity: "entities" }[unit.kind];
    const root = parseTree(text, [], { allowTrailingComma: true });
    const list = root?.children?.find((p) => p.children?.[0]?.value === section)?.children?.[1];
    const entry = list?.children?.find((n) => n.type === "string" && n.value === unit.name);
    if (!entry) return undefined;
    return { file, start: entry.offset + 1, end: entry.offset + entry.length - 1, newText: newName };
}
