// Small texture resolver for the model preview (Node only, no vscode).
// Kept isolated so it can be replaced by shared/content's ContentIndex.
//
// Engine rules (src/assets/assetload_funcs.cpp request_textures, Atlas):
// - `$N` names are block texture slots: never files.
// - `atlas:name` → textures/<atlas>/<name>.png (`blocks:stone`,
//   `entities/tireman:face_0`).
// - a plain name is loaded as textures/<name>.png; block models also look it
//   up in the `blocks` atlas, so textures/blocks/<name>.png is tried next.
// Search order: the model's pack, the engine res/ (core pack), res/content/base.

import * as fs from "node:fs";
import * as path from "node:path";

function isPackRoot(dir: string): boolean {
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) return false;
    try {
        const json = JSON.parse(fs.readFileSync(manifest, "utf8")) as unknown;
        return typeof json === "object" && json !== null && typeof (json as { id?: unknown }).id === "string";
    } catch {
        return false;
    }
}

const samePath = (a: string, b: string) =>
    process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Nearest ancestor of `file` that is a pack (package.json with `id`) or the engine res/. */
export function findPackRoot(file: string, resPath?: string): string | undefined {
    let dir = path.dirname(path.resolve(file));
    while (true) {
        if (resPath && samePath(dir, resPath)) return dir;
        if (isPackRoot(dir)) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** Folders whose `textures/` are searched, in order. */
export function textureSearchRoots(modelFile: string, resPath?: string): string[] {
    const roots: string[] = [];
    const add = (dir: string | undefined) => {
        if (dir && !roots.some((r) => samePath(r, dir))) roots.push(dir);
    };
    add(findPackRoot(modelFile, resPath));
    if (resPath) {
        add(resPath);
        add(path.join(resPath, "content", "base"));
    }
    return roots;
}

/** Relative candidate paths (under a pack root) for a texture name. */
export function textureCandidates(name: string): string[] {
    if (name === "" || name.includes("$")) return [];
    const sep = name.indexOf(":");
    if (sep >= 0) {
        const atlas = name.slice(0, sep);
        const file = name.slice(sep + 1);
        if (!atlas || !file) return [];
        return [path.join("textures", atlas, `${file}.png`)];
    }
    return [path.join("textures", `${name}.png`), path.join("textures", "blocks", `${name}.png`)];
}

/** Absolute path of a texture PNG, or undefined. */
export function resolveTexture(name: string, roots: string[]): string | undefined {
    for (const candidate of textureCandidates(name)) {
        for (const root of roots) {
            const file = path.join(root, candidate);
            if (fs.existsSync(file)) return file;
        }
    }
    return undefined;
}

/** name → absolute PNG path for every resolvable name. */
export function resolveTextures(names: string[], modelFile: string, resPath?: string): Record<string, string> {
    const roots = textureSearchRoots(modelFile, resPath);
    const result: Record<string, string> = {};
    for (const name of names) {
        const file = resolveTexture(name, roots);
        if (file) result[name] = file;
    }
    return result;
}
