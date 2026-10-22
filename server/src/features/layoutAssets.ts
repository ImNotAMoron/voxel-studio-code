// What a layout can name at runtime: loaded textures and fonts, input bindings.
// - An <image src="name"> without `atlas:` draws only a *loaded* texture
//   (util::get_texture_region → Assets::get); textures are loaded from the
//   `textures` lists of res/preload.json and each pack's preload.json
//   (AssetsLoader::processPreloadConfigs), or by a script (assets.load_texture).
// - <bindbox binding> must name a binding (Bindings::require throws): sections
//   of res/config/bindings.toml and each pack's config/bindings.toml, as
//   `section.name` (Bindings::read).

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ContentIndex } from "../../../shared/content/index";

function stampOf(files: string[]): string {
    return files.map((f) => {
        try {
            return `${f}@${fs.statSync(f).mtimeMs}`;
        } catch {
            return `${f}@-`;
        }
    }).join("|");
}

function packRoots(index: ContentIndex): string[] {
    const roots = [...index.packs.values()].map((p) => p.root);
    if (index.resPath && !roots.includes(index.resPath)) roots.push(index.resPath);
    return roots;
}

const preloadCache = new Map<string, { stamp: string; names: Set<string> }>();

/** Texture names any preload.json loads. */
export function preloadedTextures(index: ContentIndex): Set<string> {
    return preloaded(index, "textures");
}

/** Font names any preload.json loads (Label::draw skips the text with an unknown font). */
export function preloadedFonts(index: ContentIndex): Set<string> {
    return preloaded(index, "fonts");
}

function preloaded(index: ContentIndex, category: "textures" | "fonts"): Set<string> {
    const files = packRoots(index).map((r) => path.join(r, "preload.json"));
    const stamp = stampOf(files);
    const cached = preloadCache.get(category);
    if (cached?.stamp === stamp) return cached.names;
    const names = new Set<string>();
    for (const file of files) {
        try {
            const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown[] | undefined>;
            for (const entry of json[category] ?? []) {
                if (typeof entry === "string") names.add(entry);
                else if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") names.add((entry as { name: string }).name);
            }
        } catch {
            // missing or broken (the preload rules report that)
        }
    }
    preloadCache.set(category, { stamp, names });
    return names;
}

let bindingCache: { stamp: string; names: Set<string> } | undefined;

/** `section.name` of every binding the engine and the packs define. */
export function bindingNames(index: ContentIndex): Set<string> {
    const files = packRoots(index).map((r) => path.join(r, "config", "bindings.toml"));
    const stamp = stampOf(files);
    if (bindingCache?.stamp === stamp) return bindingCache.names;
    const names = new Set<string>();
    for (const file of files) {
        try {
            const toml = parseToml(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            for (const [section, value] of Object.entries(toml)) {
                if (value && typeof value === "object" && !Array.isArray(value)) {
                    for (const name of Object.keys(value)) names.add(`${section}.${name}`);
                }
            }
        } catch {
            // missing
        }
    }
    bindingCache = { stamp, names };
    return names;
}
