// What a saved file needs in a running engine (FEATURES.md §4.2). Pure.
//
// The engine re-loads assets registered with `AssetsLoader::attachToFile`
// through the VC-DBG `hot-reload` message: standalone textures, models
// (vcm/obj/vec3), VCA animations and post effects. Atlas textures, shaders,
// sounds and layouts aren't registered (ENGINE_NOTES.md). Modules go through
// `reload_module`; definitions and scripts need a content reload.
import * as path from "node:path";
import { ContentIndex, readJsonTolerant } from "../../shared/content";

export type ReloadAction =
    /** VC-DBG `hot-reload`; the engine paths the asset may have been loaded from. */
    | { kind: "asset"; files: string[]; label: string }
    /** `reload_module("pack:path")` through the dev bridge. */
    | { kind: "module"; name: string; label: string }
    /** `app.reconfig_packs({}, {})`: reloads content and reopens the world. */
    | { kind: "content"; label: string }
    /** Known file the engine can't reload while running. */
    | { kind: "restart"; label: string; reason: string };

const BUILTIN_ATLASES = ["blocks", "items", "particles"];
const MODEL_EXTS = new Set([".vcm", ".obj", ".vec3"]);
/** Folders whose files are read when content loads. */
const CONTENT_DIRS = new Set(["blocks", "items", "entities", "block_materials", "skeletons", "generators", "scripts", "layouts", "texts", "config", "presets"]);
const CONTENT_FILES = new Set(["package.json", "preload.json", "resources.json", "resource-aliases.json"]);

function atlases(index: ContentIndex): Set<string> {
    const out = new Set(BUILTIN_ATLASES);
    for (const pd of index.data.values()) {
        const preload = readJsonTolerant(path.join(pd.info.root, "preload.json"));
        const list = preload?.atlases;
        if (Array.isArray(list)) for (const a of list) if (typeof a === "string") out.add(a);
    }
    return out;
}

/**
 * Engine paths of a pack file. Workspace packs are linked into
 * `<userDir>/content/<id>` (src/run/userdir.ts), so the engine sees them as
 * `user:content/<id>/…` (the key `attachToFile` stores); the engine's own
 * files are `res:…`.
 */
export function enginePaths(index: ContentIndex, file: string): string[] {
    const pack = index.packForFile(file);
    if (!pack) return [];
    const rel = path.relative(pack.root, file).split(path.sep).join("/");
    if (index.resPath) {
        const inRes = path.relative(index.resPath, file);
        if (!inRes.startsWith("..") && !path.isAbsolute(inRes)) return [`res:${inRes.split(path.sep).join("/")}`];
    }
    // the pack-id form (`pack:textures/…`) matches nothing: verified with a client run
    return [`user:content/${pack.id}/${rel}`];
}

export function reloadActionFor(index: ContentIndex, file: string): ReloadAction | undefined {
    const pack = index.packForFile(file);
    if (!pack) return undefined;
    const rel = path.relative(pack.root, file).split(path.sep).join("/");
    const parts = rel.split("/");
    const ext = path.extname(rel).toLowerCase();
    const label = `${pack.id}:${rel}`;
    if (rel === "content.json") return undefined; // the engine writes it
    if (parts[0] === "textures" && ext === ".png") {
        const atlas = parts.slice(1, -1).join("/");
        if (atlases(index).has(atlas)) {
            return { kind: "restart", label, reason: `textures of the '${atlas}' atlas are built once; the engine doesn't hot-reload them` };
        }
        return { kind: "asset", files: enginePaths(index, file), label };
    }
    if (MODEL_EXTS.has(ext) && parts[0] === "models") return { kind: "asset", files: enginePaths(index, file), label };
    if (ext === ".vca") return { kind: "asset", files: enginePaths(index, file), label };
    if (parts[0] === "shaders") {
        if (parts[1] === "effects" && ext === ".glsl") return { kind: "asset", files: enginePaths(index, file), label };
        return { kind: "restart", label, reason: "shaders aren't hot-reloaded by the engine" };
    }
    if (parts[0] === "sounds") return { kind: "restart", label, reason: "sounds aren't hot-reloaded by the engine" };
    if (parts[0] === "modules" && ext === ".lua") {
        return { kind: "module", name: `${pack.id}:${rel.slice("modules/".length, -".lua".length)}`, label };
    }
    if (CONTENT_FILES.has(rel) || (CONTENT_DIRS.has(parts[0]) && [".json", ".toml", ".lua", ".xml", ".txt", ".vox"].includes(ext))) {
        return { kind: "content", label };
    }
    return undefined;
}
