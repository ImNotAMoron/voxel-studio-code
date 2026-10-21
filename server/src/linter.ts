// Lint orchestration: file roles, per-document linting and whole-pack linting.

import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex, PackInfo } from "../../shared/content/index";
import { FileContext, LintEnv } from "./rules/context";
import { lintBlock, lintEntity, lintItem, lintMaterial, lintSkeleton } from "./rules/defs";
import { lintLua } from "./rules/lua";
import {
    lintBiomes, lintContentJson, lintGeneratorToml, lintPackage, lintPreload, lintStructures, lintTags,
} from "./rules/pack";
import { LintSettings } from "./rules/registry";
import { Report, VcDiagnostic, jsonErrorMessage, parseJsonDoc } from "./rules/report";
import { lintVca, lintVcm } from "./rules/vcm";
import { SchemaStore } from "./schemas";

export type FileRole =
    | "package" | "content" | "block" | "item" | "entity" | "material" | "skeleton" | "generator"
    | "biomes" | "structures" | "tags" | "preload" | "lua" | "vcm" | "vca" | "skipped" | "other";

export function relPath(pack: PackInfo, file: string): string {
    return path.relative(pack.root, file).split(path.sep).join("/");
}

export function fileRole(index: ContentIndex, file: string): { pack?: PackInfo; role: FileRole; rel: string } {
    const pack = index.packForFile(file);
    if (!pack) {
        const ext = path.extname(file).toLowerCase();
        return { role: ext === ".vcm" ? "vcm" : ext === ".vca" ? "vca" : ext === ".lua" ? "lua" : "other", rel: path.basename(file) };
    }
    const rel = relPath(pack, file);
    const parts = rel.split("/");
    const base = parts[parts.length - 1];
    const ext = path.extname(base).toLowerCase();
    if (pack.id === "core" && !pack.packageFile) {
        // the engine res/ folder: only script/model files are interesting
        if (ext === ".lua") return { pack, role: "lua", rel };
        if (ext === ".vcm") return { pack, role: "vcm", rel };
        if (ext === ".vca") return { pack, role: "vca", rel };
        return { pack, role: "other", rel };
    }
    if (rel === "package.json") return { pack, role: "package", rel };
    if (rel === "content.json") return { pack, role: "content", rel };
    if (rel === "tags.toml") return { pack, role: "tags", rel };
    if (rel === "preload.json") return { pack, role: "preload", rel };
    if (["blocks", "items", "entities"].includes(parts[0]) && (parts.length === 2 || parts.length === 3)) {
        if (parts.slice(1).some((p) => p.startsWith("_"))) return { pack, role: "skipped", rel };
        if (ext === ".json" && !(parts.length === 3 && parts[1].endsWith(".files"))) {
            return { pack, role: parts[0] === "blocks" ? "block" : parts[0] === "items" ? "item" : "entity", rel };
        }
    }
    if (parts[0] === "block_materials" && parts.length === 2 && ext === ".json") return { pack, role: "material", rel };
    if (parts[0] === "skeletons" && parts.length === 2 && ext === ".json") return { pack, role: "skeleton", rel };
    if (parts[0] === "generators") {
        if (parts.length === 2 && ext === ".toml") return { pack, role: "generator", rel };
        if (parts.length === 3 && parts[1].endsWith(".files")) {
            if (base === "biomes.toml") return { pack, role: "biomes", rel };
            if (base === "structures.toml") return { pack, role: "structures", rel };
        }
    }
    if (ext === ".lua") return { pack, role: "lua", rel };
    if (ext === ".vcm") return { pack, role: "vcm", rel };
    if (ext === ".vca") return { pack, role: "vca", rel };
    return { pack, role: "other", rel };
}

export interface LintOptions {
    /** content.json was modified in the editor. */
    contentJsonEdited?: boolean;
}

export function createEnv(index: ContentIndex, settings: LintSettings, editor: boolean, schemas?: SchemaStore): LintEnv {
    return { index, settings, editor, schemas: schemas ?? new SchemaStore() };
}

/** Lints one file's text. */
export function lintDocument(env: LintEnv, file: string, text: string, options: LintOptions = {}): VcDiagnostic[] {
    const { pack, role } = fileRole(env.index, file);
    const report = new Report(file, env.settings);
    const ctx: FileContext = {
        ...env,
        file,
        text,
        pack: pack ?? { id: "", root: path.dirname(file), dependencies: [], dependencyInfo: [], builtin: false },
        report,
    };
    try {
        switch (role) {
            case "skipped":
                report.add("VC0012", 0, 0, "files and folders starting with '_' are skipped by the engine (detect_defs)");
                break;
            case "package": case "content": case "block": case "item": case "entity": case "material":
            case "skeleton": case "preload": {
                const doc = parseJsonDoc(text);
                if (doc.errors.length && !env.editor) {
                    const e = doc.errors[0];
                    report.add("VC0007", e.offset, e.offset + Math.max(1, e.length), `JSON syntax error: ${jsonErrorMessage(e)}`);
                }
                const root = doc.root;
                if (role === "content") {
                    lintContentJson(ctx, root, !!options.contentJsonEdited);
                    break;
                }
                if (!root || root.type !== "object") break;
                switch (role) {
                    case "package": lintPackage(ctx, root); break;
                    case "block": lintBlock(ctx, root); break;
                    case "item": lintItem(ctx, root); break;
                    case "entity": lintEntity(ctx, root); break;
                    case "material": lintMaterial(ctx, root); break;
                    case "skeleton": lintSkeleton(ctx, root); break;
                    case "preload": lintPreload(ctx, root); break;
                }
                break;
            }
            case "generator": lintGeneratorToml(ctx); break;
            case "biomes": lintBiomes(ctx); break;
            case "structures": lintStructures(ctx); break;
            case "tags": lintTags(ctx); break;
            case "lua":
                if (pack && (pack.id !== "core" || pack.packageFile)) lintLua(ctx);
                break;
            case "vcm": lintVcm(ctx); break;
            case "vca": lintVca(ctx); break;
        }
    } catch (err) {
        // a rule crash must never take the server down
        report.add("VC0007", 0, 0, `internal linter error: ${(err as Error).stack ?? err}`, { severity: "hint" });
    }
    return report.diagnostics;
}

/** Files of a pack that have lint rules. */
export function packFiles(index: ContentIndex, pack: PackInfo): string[] {
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === "node_modules" || e.name.startsWith(".")) continue;
                if (depth < 10) walk(abs, depth + 1);
            } else if (e.isFile()) {
                if (fileRole(index, abs).role !== "other") files.push(abs);
            }
        }
    };
    walk(pack.root, 0);
    return files;
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

const TEXT_EXTS = new Set([".json", ".toml", ".lua", ".xml", ".vcm", ".vca", ".obj", ".txt", ".glsl", ".glslv", ".glslf"]);

/** String literals / words mentioned anywhere in the packs' text files. */
export function collectMentions(index: ContentIndex, getText: (file: string) => string | undefined = readText): Set<string> {
    const mentions = new Set<string>();
    const add = (s: string) => {
        if (!s || s.length > 200) return;
        mentions.add(s);
        const colon = s.lastIndexOf(":");
        if (colon >= 0) mentions.add(s.slice(colon + 1));
        const dot = s.lastIndexOf(".");
        if (dot > 0) mentions.add(s.slice(0, dot));
    };
    for (const pd of index.data.values()) {
        const walk = (dir: string, depth: number) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const e of entries) {
                const abs = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "sounds" || depth > 10) continue;
                    walk(abs, depth + 1);
                } else if (TEXT_EXTS.has(path.extname(e.name).toLowerCase())) {
                    const text = getText(abs);
                    if (!text || text.length > 2_000_000) continue;
                    for (const m of text.matchAll(/"((?:[^"\\\n]|\\.){1,200})"|'((?:[^'\\\n]|\\.){1,200})'/g)) add(m[1] ?? m[2]);
                    if (/\.(vcm|vca|obj|xml)$/i.test(e.name)) {
                        for (const m of text.matchAll(/[A-Za-z0-9_$][A-Za-z0-9_:./$-]*/g)) add(m[0]);
                    }
                }
            }
        };
        if (pd.info.id === "core") {
            for (const sub of ["scripts", "modules", "layouts", "models", "preload.json"]) {
                const p = path.join(pd.info.root, sub);
                if (sub.endsWith(".json")) {
                    const text = getText(p);
                    if (text) for (const m of text.matchAll(/"([^"\\\n]{1,200})"/g)) add(m[1]);
                } else walk(p, 1);
            }
        } else {
            walk(pd.info.root, 0);
        }
    }
    return mentions;
}

/** Unused textures (blocks/items atlases), sounds and models of a pack, plus skipped definitions. */
export function lintPackAssets(env: LintEnv, pack: PackInfo, mentions: Set<string>): VcDiagnostic[] {
    const result: VcDiagnostic[] = [];
    const pd = env.index.getPackData(pack.id);
    if (!pd || pack.shadowedBy) return result;
    const add = (code: string, file: string, message: string, tags?: ("unnecessary")[]) => {
        const report = new Report(file, env.settings);
        report.add(code, 0, 0, message, { tags });
        result.push(...report.diagnostics);
    };
    for (const [key, file] of pd.textures) {
        const m = /^(blocks|items)\/([^/]+)$/.exec(key);
        if (!m) continue;
        const [, atlas, name] = m;
        const base = name.replace(/_opaque$/, "");
        if (mentions.has(name) || mentions.has(`${atlas}:${name}`) || mentions.has(base) || name === "notfound") continue;
        if (pd.textureAnimations.has(key)) continue;
        add("VC0060", file, `texture '${atlas}:${name}' is not referenced by any definition, model, layout or script`, ["unnecessary"]);
    }
    const soundNames = new Map<string, string>();
    for (const [key, file] of pd.sounds) {
        const m = /^(.*)_(\d+)$/.exec(key);
        const name = m && (m[2] === "0" || pd.sounds.has(m[1]) || pd.sounds.has(m[1] + "_0")) ? m[1] : key;
        if (!soundNames.has(name)) soundNames.set(name, file);
    }
    for (const [name, file] of soundNames) {
        if (mentions.has(name)) continue;
        const slash = name.lastIndexOf("/");
        const dir = slash >= 0 ? name.slice(0, slash + 1) : "";
        // dynamic names like "steps/"..material are common: accept a mentioned prefix
        if (dir && [...mentions].some((m) => m === dir || m.endsWith("/" + dir))) continue;
        add("VC0061", file, `sound '${name}' is not referenced by any material, preload.json or script`, ["unnecessary"]);
    }
    for (const [name, file] of pd.models) {
        if (mentions.has(name)) continue;
        add("VC0062", file, `model '${name}' is not referenced by any definition, skeleton, preload.json or script`, ["unnecessary"]);
    }
    return result;
}

/** Lints every lint-able file of a pack. `getText` lets the server substitute open documents. */
export function lintPack(
    env: LintEnv,
    pack: PackInfo,
    getText: (file: string) => string | undefined = readText,
    mentions?: Set<string>,
): Map<string, VcDiagnostic[]> {
    const result = new Map<string, VcDiagnostic[]>();
    for (const file of packFiles(env.index, pack)) {
        const text = getText(file);
        if (text === undefined) continue;
        result.set(file, lintDocument(env, file, text));
    }
    for (const d of lintPackAssets(env, pack, mentions ?? collectMentions(env.index, getText))) {
        const list = result.get(d.file) ?? [];
        list.push(d);
        result.set(d.file, list);
    }
    return result;
}
