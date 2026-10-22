// Reference kinds of string values in definition files and Lua calls, with
// candidate lists (completion) and resolution (definition / hover).

import * as path from "node:path";
import { getLocation, Location, Node, parseTree, findNodeAtOffset } from "jsonc-parser";
import { ContentIndex } from "../../../shared/content/index";
import { sanitizeJson } from "../../../shared/content/json";
import { FileRole } from "../linter";

export type RefKind =
    | "blockTexture" | "atlasTexture" | "itemIcon" | "texturePath" | "block" | "item" | "entity" | "material"
    | "model" | "component" | "skeleton" | "script" | "layout" | "sound" | "module" | "unit";

const SOUND_KEYS = new Set(["steps-sound", "place-sound", "break-sound", "hit-sound"]);

/** The reference kind of the JSON value at `location.path`, for the given file role. */
export function jsonRefKind(role: FileRole, p: (string | number)[], json: unknown): RefKind | undefined {
    const last = p[p.length - 1];
    const key = typeof last === "number" ? p[p.length - 2] : last;
    const inVariant = p[0] === "state-based" && p[1] === "variants";
    switch (role) {
        case "block": {
            if (p[0] === "particles") {
                return (p.length === 2 && p[1] === "texture") || (p.length === 3 && p[1] === "frames") ? "atlasTexture" : undefined;
            }
            const rest = inVariant ? p.slice(3) : p;
            if (inVariant && typeof p[2] !== "number") return undefined;
            if (rest[0] === "texture-faces" && rest.length === 2) return "blockTexture";
            if (rest.length !== 1) return undefined;
            if (key === "texture") return "blockTexture";
            if (key === "model-name") return "model";
            if (inVariant) return undefined;
            if (key === "overlay-texture") return "atlasTexture";
            if (key === "picking-item") return "item";
            if (key === "parent") return "block";
            if (key === "material") return "material";
            if (key === "script-name") return "script";
            if (key === "ui-layout") return "layout";
            return undefined;
        }
        case "item": {
            if (p.length !== 1) return undefined;
            if (key === "icon") {
                const iconType = json && typeof json === "object" ? (json as Record<string, unknown>)["icon-type"] : undefined;
                return iconType === "block" ? "block" : "itemIcon";
            }
            if (key === "placing-block") return "block";
            if (key === "parent") return "item";
            if (key === "script-name") return "script";
            if (key === "model-name") return "model";
            return undefined;
        }
        case "entity": {
            if (p[0] === "components" && (p.length === 2 || (p.length === 3 && p[2] === "name"))) return "component";
            if (p.length !== 1) return undefined;
            if (key === "skeleton-name") return "skeleton";
            if (key === "parent") return "entity";
            if (key === "material") return "material";
            return undefined;
        }
        case "material":
            return p.length === 1 && typeof key === "string" && SOUND_KEYS.has(key) ? "sound" : undefined;
        case "skeleton":
            return key === "model" ? "model" : undefined;
        case "preload": {
            const cat = p[0];
            if (p.length !== 2 && !(p.length === 3 && p[2] === "name")) return undefined;
            if (cat === "sounds") return "sound";
            if (cat === "models") return "model";
            if (cat === "textures") return "texturePath";
            return undefined;
        }
        default:
            return undefined;
    }
}

export interface JsonStringAt {
    kind: RefKind;
    node?: Node;
    value: string;
    location: Location;
}

/** The string node (or insertion point) at `offset` and its reference kind. */
export function jsonStringAt(role: FileRole, text: string, offset: number): JsonStringAt | undefined {
    const clean = sanitizeJson(text);
    const location = getLocation(clean, offset);
    if (location.isAtPropertyKey) return undefined;
    const root = parseTree(clean, [], { allowTrailingComma: true });
    let json: unknown;
    if (root) {
        try {
            json = JSON.parse(JSON.stringify(nodeToValue(root)));
        } catch {
            json = undefined;
        }
    }
    const kind = jsonRefKind(role, location.path, json);
    if (!kind) return undefined;
    const node = root ? findNodeAtOffset(root, offset, true) : undefined;
    const stringNode = node && node.type === "string" ? node : undefined;
    return { kind, node: stringNode, value: stringNode ? String(stringNode.value) : "", location };
}

export function nodeToValue(node: Node): unknown {
    if (node.type === "object") {
        const o: Record<string, unknown> = {};
        for (const p of node.children ?? []) {
            const [k, v] = p.children ?? [];
            if (k && v) o[String(k.value)] = nodeToValue(v);
        }
        return o;
    }
    if (node.type === "array") return (node.children ?? []).map(nodeToValue);
    return node.value;
}

export function candidates(index: ContentIndex, kind: RefKind, fromPack?: string): string[] {
    const out = new Set<string>();
    switch (kind) {
        case "blockTexture":
            for (const n of index.textureNames("blocks")) out.add(n);
            break;
        case "itemIcon":
            for (const n of index.textureNames("items")) out.add("items:" + n);
            for (const n of index.textureNames("blocks")) out.add("blocks:" + n);
            break;
        case "atlasTexture":
            for (const atlas of ["blocks", "items", "particles"]) for (const n of index.textureNames(atlas)) out.add(`${atlas}:${n}`);
            break;
        case "texturePath":
            for (const pd of index.data.values()) for (const k of pd.textures.keys()) out.add(k);
            break;
        case "block":
            for (const id of index.blocks.keys()) out.add(id);
            break;
        case "item":
            for (const id of index.items.keys()) out.add(id);
            break;
        case "entity":
            for (const id of index.entities.keys()) out.add(id);
            break;
        case "unit":
            for (const map of [index.blocks, index.items]) for (const id of map.keys()) out.add(id);
            break;
        case "material":
            for (const pd of index.data.values()) for (const id of pd.materials.keys()) out.add(id);
            break;
        case "model":
            for (const pd of index.data.values()) for (const n of pd.models.keys()) out.add(n);
            break;
        case "component":
            for (const pd of index.data.values()) for (const id of pd.components.keys()) out.add(id);
            break;
        case "skeleton":
            for (const pd of index.data.values()) {
                for (const id of pd.skeletons.keys()) out.add(id);
                for (const [n, f] of pd.models) if (f.endsWith(".vcm")) out.add(n);
            }
            break;
        case "script": {
            const pd = fromPack ? index.getPackData(fromPack) : undefined;
            if (pd) for (const n of pd.scripts.keys()) {
                if (!n.startsWith("components/") && !["world", "hud", "content"].includes(n)) out.add(n);
            }
            break;
        }
        case "layout":
            for (const pd of index.data.values()) for (const n of pd.layouts.keys()) out.add(`${pd.info.id}:${n}`);
            break;
        case "sound":
            for (const n of index.soundNames()) out.add(n);
            break;
        case "module":
            for (const pd of index.data.values()) {
                for (const n of pd.modules.keys()) {
                    if (pd.info.id === "core" && n.startsWith("internal/")) continue;
                    out.add(pd.info.id === fromPack ? n : `${pd.info.id}:${n}`);
                    if (pd.info.id === fromPack) out.add(`${pd.info.id}:${n}`);
                }
            }
            break;
    }
    return [...out].sort();
}

/** Resolves a reference to a file (go-to-definition). */
export function resolveRef(index: ContentIndex, kind: RefKind, value: string, fromPack?: string): string | undefined {
    switch (kind) {
        case "blockTexture": return index.resolveTexture("blocks", value, fromPack);
        case "itemIcon":
        case "atlasTexture": return index.resolveTextureRef(value, fromPack);
        case "texturePath": return index.resolveTexture("", value, fromPack);
        case "block": return index.blocks.get(value)?.file;
        case "item": {
            const item = index.items.get(value);
            if (item?.file) return item.file;
            if (item?.blockOf) return index.blocks.get(item.blockOf)?.file;
            return undefined;
        }
        case "entity": return index.entities.get(value)?.file;
        case "unit": return index.unitFile(value);
        case "material": return index.resolveMaterial(value);
        case "model": return index.resolveModel(value, fromPack);
        case "component": return index.resolveComponent(value);
        case "skeleton": return value.includes(":") ? index.resolveSkeleton(value) : index.resolveModel(value, fromPack);
        case "script": return fromPack ? index.resolveScript(fromPack, value) : undefined;
        case "layout": return index.resolveLayout(value);
        case "sound": return index.resolveSound(value, fromPack);
        case "module": return index.resolveModule(value, fromPack);
    }
}

export const REF_LABEL: Record<RefKind, string> = {
    blockTexture: "block texture",
    atlasTexture: "texture",
    itemIcon: "icon texture",
    texturePath: "texture",
    block: "block",
    item: "item",
    entity: "entity",
    unit: "block/item",
    material: "block material",
    model: "model",
    component: "entity component",
    skeleton: "skeleton",
    script: "script",
    layout: "UI layout",
    sound: "sound",
    module: "module",
};

/** Lua `callee("…")` string at the cursor. */
export interface LuaStringAt {
    kind: RefKind;
    value: string;
    /** Offsets of the string contents (without quotes). */
    start: number;
    end: number;
}

const LUA_ID_CALLS: [RegExp, RefKind][] = [
    [/\bblock\.(index|has_tag|properties)\s*$/, "block"],
    [/\bitem\.(index|properties)\s*$/, "item"],
    [/\bentities\.(spawn|def_index)\s*$/, "entity"],
    [/\baudio\.play_sound(_2d)?\s*$/, "sound"],
    [/\bhud\.(show_overlay|open_permanent)\s*$/, "layout"],
    [/(^|[^.\w])require\s*$/, "module"],
];

export function luaStringAt(text: string, offset: number): LuaStringAt | undefined {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    let lineEnd = text.indexOf("\n", offset);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    const col = offset - lineStart;
    const re = /(["'])((?:\\.|(?!\1).)*?)(\1|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
        const contentStart = m.index + 1;
        const contentEnd = contentStart + m[2].length;
        if (col < contentStart || col > contentEnd) continue;
        const kind = luaCallKind(line.slice(0, m.index));
        return kind ? { kind, value: m[2], start: lineStart + contentStart, end: lineStart + contentEnd } : undefined;
    }
    return undefined;
}

/** Reference kind of a Lua string literal from the line text before its opening quote. */
export function luaCallKind(before: string): RefKind | undefined {
    const callee = before.replace(/\(\s*$/, "");
    return LUA_ID_CALLS.find(([pattern]) => pattern.test(callee))?.[1];
}

export function displayPath(index: ContentIndex, file: string): string {
    const pack = index.packForFile(file);
    if (!pack) return file;
    return `${pack.id}:${path.relative(pack.root, file).split(path.sep).join("/")}`;
}
