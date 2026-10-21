// package.json, tags.toml, preload.json, generators.

import * as fs from "node:fs";
import * as path from "node:path";
import { Node } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import {
    GeneratorInfo, MODEL_EXTENSIONS, SOUND_EXTENSIONS, checkPackId, isVersionPattern, parseDependency, versionSatisfies,
} from "../../../shared/content/index";
import { FileContext } from "./context";
import { arrayItems, at, keyNode, objectEntries, str } from "./report";
import { TomlLocator } from "./toml";

/** Reads width/height from a PNG IHDR chunk. */
export function pngSize(file: string): { width: number; height: number } | undefined {
    try {
        const fd = fs.openSync(file, "r");
        const buf = Buffer.alloc(24);
        fs.readSync(fd, buf, 0, 24, 0);
        fs.closeSync(fd);
        if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    } catch {
        return undefined;
    }
}

export function lintPackage(ctx: FileContext, root: Node) {
    const { report, index, pack } = ctx;
    const idNode = at(root, ["id"]);
    const id = str(idNode);
    if (id === undefined) {
        report.add("VC0001", 0, 1, idNode ? "'id' must be a string" : "package.json has no 'id' (the engine uses 'none' and rejects the pack)");
    } else {
        const error = checkPackId(id);
        if (error) report.node("VC0001", idNode, `${error} (the engine skips this pack)`);
        if (pack.shadowedBy && !error) {
            report.node("VC0001", idNode, `another pack with id '${id}' is at ${pack.shadowedBy}; only one of them is loaded`, { severity: "warning" });
        }
        const folder = path.basename(pack.root);
        if (!error && folder !== id) {
            report.node("VC0002", idNode,
                `pack folder '${folder}' differs from the id '${id}': worlds look packs up by folder name (ContentPack::findPack)`);
        }
    }
    const versionNode = at(root, ["version"]);
    const version = str(versionNode);
    if (version !== undefined && !isVersionPattern(version)) {
        report.node("VC0003", versionNode,
            `version '${version}' is not 'major.minor[.patch]': dependency version checks fall back to exact string comparison`);
    }
    const deps = at(root, ["dependencies"]);
    for (const item of arrayItems(deps)) {
        const raw = str(item);
        if (raw === undefined) {
            report.node("VC0004", item, "dependency must be a string");
            continue;
        }
        const dep = parseDependency(raw);
        if (dep.error) {
            report.node("VC0004", item, `dependency '${raw}': ${dep.error}`);
            continue;
        }
        if (dep.id === id) {
            report.node("VC0004", item, "a pack can't depend on itself");
            continue;
        }
        const target = index.packs.get(dep.id);
        if (!target || target.id === "core") {
            if (dep.level === "required") {
                report.node("VC0005", item,
                    `required dependency '${dep.id}' is not found in the workspace or the engine res/content (the engine refuses to load the pack)`,
                    { severity: "warning" });
            }
            continue;
        }
        if (dep.level !== "weak" && !versionSatisfies(dep, target.version ?? "0.0")) {
            report.node("VC0005", item,
                `'${dep.id}' version ${target.version ?? "0.0"} does not meet the required '${dep.op}${dep.version}'`);
        }
    }
    // icon
    const icon = path.join(pack.root, "icon.png");
    if (!fs.existsSync(icon)) {
        report.add("VC0006", 0, 1, "pack has no icon.png (recommended size 128×128)");
    } else {
        const size = pngSize(icon);
        if (size && (size.width !== 128 || size.height !== 128)) {
            report.add("VC0006", 0, 1, `icon.png is ${size.width}×${size.height}; the recommended size is 128×128`);
        }
    }
}

export function lintTags(ctx: FileContext) {
    const { report, index } = ctx;
    let value: Record<string, unknown>;
    try {
        value = parseToml(ctx.text) as Record<string, unknown>;
    } catch (err) {
        reportTomlError(ctx, err);
        return;
    }
    const loc = new TomlLocator(ctx.text);
    for (const [tag, list] of Object.entries(value)) {
        if (!Array.isArray(list)) continue;
        for (const id of list) {
            if (typeof id !== "string") continue;
            if (index.blocks.has(id) || index.items.has(id)) continue;
            const token = loc.strings("", id)[0];
            const colon = id.indexOf(":");
            const packKnown = colon >= 0 && index.packs.has(id.slice(0, colon));
            if (colon >= 0 && !packKnown) continue; // other pack not available: can't verify
            report.add("VC0027", token?.start ?? 0, token?.end ?? 0,
                colon < 0
                    ? `tag '${tag}': '${id}' must be a full id 'pack:name'`
                    : `tag '${tag}': no block or item '${id}' (silently ignored)`);
        }
    }
}

export function reportTomlError(ctx: FileContext, err: unknown) {
    const e = err as { message?: string; line?: number; column?: number };
    let offset = 0;
    if (e.line) {
        const lines = ctx.text.split("\n");
        for (let i = 0; i < e.line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
        offset += Math.max(0, (e.column ?? 1) - 1);
    }
    ctx.report.add("VC0007", offset, offset + 1, "TOML syntax error: " + String(e.message ?? err).split("\n")[0]);
}

function existsAny(ctx: FileContext, rels: string[]): boolean {
    for (const pd of ctx.index.lookupOrder(ctx.pack.id)) {
        for (const rel of rels) if (fs.existsSync(path.join(pd.info.root, rel))) return true;
    }
    return false;
}

const PRELOAD_CATEGORIES: Record<string, (name: string) => string[]> = {
    animation: (n) => [`animation/${n}.vca`],
    atlases: (n) => [`textures/${n}`],
    fonts: (n) => (path.extname(n) ? [n] : [`${n}_0.png`]),
    models: (n) => MODEL_EXTENSIONS.map((e) => `models/${n}${e}`),
    "post-effects": (n) => [`shaders/effects/${n}.glsl`],
    shaders: (n) => [`shaders/${n}.glslv`],
    skeletons: (n) => [`skeletons/${n}.json`],
    sounds: (n) => SOUND_EXTENSIONS.flatMap((e) => [`sounds/${n}${e}`, `sounds/${n}_0${e}`]),
    textures: (n) => [`textures/${n}.png`],
};

export function lintPreload(ctx: FileContext, root: Node) {
    const { report } = ctx;
    for (const { key, keyNode: kn, valueNode } of objectEntries(root)) {
        const candidates = PRELOAD_CATEGORIES[key];
        if (!candidates) {
            report.node("VC0039", kn, key === "layouts"
                ? "layouts are loaded automatically; this category is ignored"
                : `unknown preload category '${key}' is ignored (expected ${Object.keys(PRELOAD_CATEGORIES).join(", ")})`,
                { severity: key === "layouts" ? "information" : "warning" });
            continue;
        }
        for (const item of arrayItems(valueNode)) {
            let name: string | undefined;
            let pathOverride: string | undefined;
            let node: Node | undefined = item;
            if (item.type === "string") name = item.value as string;
            else if (item.type === "object") {
                name = str(at(item, ["name"]));
                const p = at(item, ["path"]);
                pathOverride = str(p);
                node = p ?? at(item, ["name"]) ?? item;
            }
            if (name === undefined) continue;
            let rels: string[];
            if (pathOverride !== undefined) {
                const exts = key === "atlases" ? [""] : key === "sounds" ? SOUND_EXTENSIONS.flatMap((e) => [e, "_0" + e])
                    : key === "models" ? MODEL_EXTENSIONS : key === "shaders" ? [".glslv"] : key === "post-effects" ? [".glsl"]
                    : key === "animation" ? [".vca"] : key === "skeletons" ? [".json"] : key === "fonts" ? ["_0.png", ""] : [".png"];
                rels = exts.map((e) => pathOverride + e);
            } else {
                rels = candidates(name);
            }
            if (!existsAny(ctx, rels)) {
                report.node("VC0039", node, `preload ${key} entry '${pathOverride ?? name}' not found (${rels[0]})`);
            }
        }
    }
}

// ---- generators ----

function generatorOf(ctx: FileContext): GeneratorInfo | undefined {
    const pd = ctx.index.getPackData(ctx.pack.id);
    if (!pd) return undefined;
    for (const gen of pd.generators.values()) {
        if (path.resolve(gen.file) === path.resolve(ctx.file)) return gen;
        if (path.resolve(path.dirname(ctx.file)) === path.resolve(gen.filesDir)) return gen;
    }
    return undefined;
}

function readGeneratorToml(gen: GeneratorInfo): Record<string, unknown> {
    try {
        return parseToml(fs.readFileSync(gen.file, "utf8")) as Record<string, unknown>;
    } catch {
        return {};
    }
}

export function lintGeneratorToml(ctx: FileContext) {
    let value: Record<string, unknown>;
    try {
        value = parseToml(ctx.text) as Record<string, unknown>;
    } catch (err) {
        reportTomlError(ctx, err);
        return;
    }
    const loc = new TomlLocator(ctx.text);
    const params = typeof value["biome-parameters"] === "number" ? (value["biome-parameters"] as number) : 0;
    const inputs = value["heightmap-inputs"];
    if (Array.isArray(inputs)) {
        for (const index of inputs) {
            if (typeof index !== "number" || index <= 0 || index > params) {
                const [s, e] = loc.keyRange("", "heightmap-inputs");
                ctx.report.add("VC0036", s, e, `invalid biome parameter index ${String(index)} in heightmap-inputs (1..${params}); the engine throws`);
            }
        }
    }
    const gen = generatorOf(ctx);
    if (gen && !gen.biomesFile && !hasBiomesElsewhere(ctx, gen)) {
        ctx.report.add("VC0036", 0, Math.min(ctx.text.indexOf("\n") >= 0 ? ctx.text.indexOf("\n") : ctx.text.length, ctx.text.length),
            `generator has no ${gen.name}.files/biomes.toml: at least one biome is required (the engine throws)`);
    }
}

function hasBiomesElsewhere(ctx: FileContext, gen: GeneratorInfo): boolean {
    for (const pd of ctx.index.data.values()) {
        if (pd.info.id === gen.pack) continue;
        if (fs.existsSync(path.join(pd.info.root, "generators", gen.name + ".files", "biomes.toml"))) return true;
    }
    return false;
}

export function lintBiomes(ctx: FileContext) {
    const { report, index } = ctx;
    let value: Record<string, unknown>;
    try {
        value = parseToml(ctx.text) as Record<string, unknown>;
    } catch (err) {
        reportTomlError(ctx, err);
        return;
    }
    const gen = generatorOf(ctx);
    const params = gen ? Number(readGeneratorToml(gen)["biome-parameters"] ?? 0) || 0 : 0;
    // structures.toml is combined across packs (ResPaths::readCombinedObject)
    const structures = new Set<string>();
    if (gen) {
        for (const pd of index.data.values()) {
            const other = [...pd.generators.values()].find((g) => g.name === gen.name);
            if (other) for (const s of other.structures) structures.add(s);
        }
    }
    const loc = new TomlLocator(ctx.text);
    const blockRef = (section: string, id: unknown, what: string) => {
        if (typeof id !== "string") return;
        if (index.blocks.has(id)) return;
        const colon = id.indexOf(":");
        if (colon >= 0 && !index.packs.has(id.slice(0, colon))) return;
        const token = loc.strings(section, id)[0];
        report.add("VC0036", token?.start ?? 0, token?.end ?? 0,
            colon < 0 ? `${what} '${id}' must be a full block id 'pack:name'` : `${what}: no such block '${id}'`);
    };
    for (const [biome, raw] of Object.entries(value)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const b = raw as Record<string, unknown>;
        const header = loc.header(biome);
        const hs = header?.start ?? 0;
        const he = header?.end ?? 0;
        const parameters = Array.isArray(b.parameters) ? b.parameters : [];
        if (gen && parameters.length < params) {
            const [s, e] = loc.keyRange(biome, "parameters");
            report.add("VC0037", s || hs, e || he,
                `biome '${biome}' has ${parameters.length} parameter(s), the generator declares biome-parameters = ${params} (the engine throws)`);
        }
        for (const field of ["layers", "sea-layers"]) {
            const layers = b[field];
            if (!Array.isArray(layers)) {
                const [s, e] = loc.keyRange(biome, field);
                report.add("VC0036", s || hs, e || he, `biome '${biome}': '${field}' list is required (the engine throws)`);
                continue;
            }
            let resizeable = 0;
            for (const layer of layers) {
                if (!layer || typeof layer !== "object") continue;
                const l = layer as Record<string, unknown>;
                blockRef(biome, l.block, `${field} block`);
                if (l.height === -1) {
                    resizeable++;
                    if (resizeable === 2) {
                        const heights = loc.keys(biome, "height").filter((t) => loc.rawValueAfter(t) === "-1");
                        const t = heights[1] ?? heights[0];
                        report.add("VC0038", t?.start ?? hs, t?.end ?? he,
                            `biome '${biome}' ${field}: only one resizeable layer (height = -1) allowed (the engine throws)`);
                    }
                }
            }
        }
        for (const plant of Array.isArray(b.plants) ? b.plants : []) {
            if (plant && typeof plant === "object") {
                const p = plant as Record<string, unknown>;
                blockRef(biome, p.block, "plant");
                if (typeof p.weight === "number" && p.weight <= 0) {
                    const [s, e] = loc.keyRange(biome, "plants");
                    report.add("VC0036", s, e, `biome '${biome}': plant weight must be positive (the engine throws)`);
                }
            }
        }
        for (const st of Array.isArray(b.structures) ? b.structures : []) {
            if (!st || typeof st !== "object") continue;
            const s = st as Record<string, unknown>;
            if (typeof s.name === "string" && gen && !structures.has(s.name)) {
                const token = loc.strings(biome, s.name)[0];
                report.add("VC0036", token?.start ?? hs, token?.end ?? he,
                    `biome '${biome}': structure '${s.name}' is not declared in ${gen.name}.files/structures.toml`);
            }
            if (typeof s.weight === "number" && s.weight <= 0) {
                const [a, e] = loc.keyRange(biome, "structures");
                report.add("VC0036", a, e, `biome '${biome}': structure weight must be positive (the engine throws)`);
            }
        }
    }
}

export function lintStructures(ctx: FileContext) {
    let value: Record<string, unknown>;
    try {
        value = parseToml(ctx.text) as Record<string, unknown>;
    } catch (err) {
        reportTomlError(ctx, err);
        return;
    }
    const gen = generatorOf(ctx);
    if (!gen) return;
    const loc = new TomlLocator(ctx.text);
    for (const name of Object.keys(value)) {
        const rel = path.join("generators", gen.name + ".files", "fragments", name + ".vox");
        if (existsAny(ctx, [rel])) continue;
        const token = loc.keys("", name)[0] ?? loc.header(name);
        ctx.report.add("VC0035", token?.start ?? 0, token?.end ?? 0,
            `structure '${name}': fragment file ${gen.name}.files/fragments/${name}.vox not found (the engine throws)`);
    }
}

export function lintContentJson(ctx: FileContext, root: Node | undefined, edited: boolean) {
    if (!edited) return;
    const node = root ? keyNode(root, "blocks") ?? root : undefined;
    const end = node ? node.offset + Math.min(node.length, 1) : 1;
    ctx.report.add("VC0013", node?.offset ?? 0, end,
        "content.json is generated by the engine (fixPackIndices); editing it by hand can reorder content indices and corrupt existing worlds");
}
