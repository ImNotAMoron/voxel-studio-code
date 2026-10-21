// Validates generated schemas and runs every definition file of the engine's
// built-in packs (res/, res/content/base, packs/backrooms) against them.
//   cd vscode-extension && node --import tsx --test test/schemas/*.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { Validator, checkSchemaStructure, type Schema } from "./mini-validator";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMAS = path.join(EXT, "schemas");
const ROOT = path.resolve(process.env.VOXELCORE_ROOT ?? path.join(EXT, ".."));

interface CatalogEntry {
    schema: string;
    format: "json" | "toml";
    fileMatch: string[];
    regexMatch?: string[];
    refOnly?: boolean;
}

const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(path.join(SCHEMAS, "catalog.json"), "utf8"));
const cache = new Map<string, Schema>();
const load = (file: string): Schema => {
    if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(path.join(SCHEMAS, file), "utf8")));
    return cache.get(file)!;
};
const validator = new Validator(load);

/** VS Code-style glob → RegExp (`**`, `*`, `?`); matched against a /-separated path. */
function globRegex(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            if (glob[i + 2] === "/") {
                re += "(?:.*/)?";
                i += 2;
            } else {
                re += ".*";
                i += 1;
            }
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
}

function matches(entry: CatalogEntry, rel: string): boolean {
    const inc = entry.fileMatch.filter((g) => !g.startsWith("!"));
    const exc = entry.fileMatch.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
    const p = "/" + rel; // so that "**/x" also matches a top-level "x"
    const hit = (g: string) => globRegex(g.startsWith("**/") ? g : "**/" + g).test(p.slice(1)) || globRegex(g).test(p);
    return inc.some(hit) && !exc.some(hit);
}

function readData(file: string, format: "json" | "toml"): unknown {
    const text = fs.readFileSync(file, "utf8");
    if (format === "toml") return parseToml(text);
    const errs: ParseError[] = [];
    const value = parseJsonc(text, errs, { allowTrailingComma: true });
    if (errs.length) throw new Error(`${file}: ${errs.map((e) => printParseErrorCode(e.error) + "@" + e.offset).join(", ")}`);
    return value;
}

function walk(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === "node_modules" || e.name.startsWith(".")) continue;
            walk(p, out);
        } else if (/\.(json|toml)$/.test(e.name)) out.push(p);
    }
    return out;
}

const fmt = (errs: { path: string; message: string }[]) => errs.map((e) => `  ${e.path}: ${e.message}`).join("\n");

describe("schema files", () => {
    const files = fs.readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"));

    test("catalog lists every schema exactly once", () => {
        assert.deepEqual([...catalog.map((c) => c.schema)].sort(), [...files].sort());
        for (const c of catalog) {
            assert.ok(c.format === "json" || c.format === "toml", c.schema);
            if (c.format === "toml") assert.equal(c.regexMatch?.length, c.fileMatch.length, c.schema);
        }
    });

    for (const f of files) {
        test(`${f} is well-formed draft-07`, () => {
            const s = load(f) as Record<string, any>;
            assert.equal(s.$schema, "http://json-schema.org/draft-07/schema#");
            assert.ok(s.$id && s.title, "needs $id and title");
            const problems = checkSchemaStructure(s, load);
            assert.deepEqual(problems, []);
            // no unresolved overlay extensions leaked into the output
            assert.ok(!/"x-[\w-]+":/.test(JSON.stringify(s)), "x-* keys leaked");
            // root properties are documented
            for (const [k, v] of Object.entries<any>(s.properties ?? {})) {
                assert.ok(v.description || v.markdownDescription, `${f}: property ${k} has no description`);
            }
        });
    }

    test("contrib/schemas.json is in sync with the catalog", () => {
        const contrib = JSON.parse(fs.readFileSync(path.join(EXT, "contrib", "schemas.json"), "utf8"));
        const json = catalog.filter((c) => c.format === "json" && c.fileMatch.length);
        assert.equal(contrib.contributes.jsonValidation.length, json.length);
        for (const c of json) {
            const entry = contrib.contributes.jsonValidation.find((e: any) => e.url === `./schemas/${c.schema}`);
            assert.ok(entry, c.schema);
            for (const g of c.fileMatch) assert.ok(entry.fileMatch.includes(g));
        }
    });
});

describe("generator", () => {
    const engineAvailable = fs.existsSync(path.join(ROOT, "src", "content", "loading", "BlockLoader.cpp"));
    test("outputs are up to date with the engine sources (gen-schemas --check)", { skip: !engineAvailable }, () => {
        execFileSync(process.execPath, [path.join(EXT, "tools", "gen-schemas.mjs"), "--check"], {
            env: { ...process.env, VOXELCORE_ROOT: ROOT },
            stdio: "pipe",
        });
    });
});

describe("engine content validates", () => {
    const roots = [
        path.join(ROOT, "res"), // the `core` pack + res/content/*
        path.join(ROOT, "packs"),
    ];
    const files = roots.flatMap((r) => walk(r));
    const counts = new Map<string, number>();
    const packRoots = new Set<string>();
    for (const f of files) if (path.basename(f) === "package.json") packRoots.add(path.dirname(f));

    for (const file of files) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        const entries = catalog.filter((c) => !c.refOnly && file.endsWith(`.${c.format}`) && matches(c, rel));
        // package.json / content.json of pack roots outside a content/ folder (integration applies these)
        const base = path.basename(file);
        const dir = path.dirname(file);
        if (packRoots.has(dir) && (base === "package.json" || base === "content.json")) {
            const schema = base === "package.json" ? "package.schema.json" : "content.schema.json";
            if (!entries.some((e) => e.schema === schema)) entries.push(catalog.find((c) => c.schema === schema)!);
        }
        if (!entries.length) continue;
        test(rel, () => {
            assert.equal(entries.length, 1, `matched by several schemas: ${entries.map((e) => e.schema)}`);
            const [entry] = entries;
            counts.set(entry.schema, (counts.get(entry.schema) ?? 0) + 1);
            const data = readData(file, entry.format);
            const errs = validator.validate(load(entry.schema), data);
            assert.equal(errs.length, 0, `${rel} vs ${entry.schema}:\n${fmt(errs)}`);
        });
    }

    test("every schema with a file pattern was exercised", () => {
        const untested = catalog.filter((c) => !c.refOnly && !counts.get(c.schema)).map((c) => c.schema);
        // nothing in the engine repo ships these files
        const allowed = new Set(["resource-aliases.schema.json", "user-props.schema.json", "tags.schema.json"]);
        for (const s of untested) if (!allowed.has(s)) assert.fail(`no engine file validated against ${s}`);
    });
});

describe("negative cases", () => {
    const v = (schema: string, data: unknown) => validator.validate(load(schema), data);
    const bad = (schema: string, data: unknown, re?: RegExp) => {
        const errs = v(schema, data);
        assert.ok(errs.length > 0, `expected errors for ${JSON.stringify(data)}`);
        if (re) assert.ok(errs.some((e) => re.test(e.path + " " + e.message)), fmt(errs));
    };
    const good = (schema: string, data: unknown) => assert.deepEqual(v(schema, data), []);

    test("misspelled block property is rejected", () => bad("block.schema.json", { emision: [1, 2, 3] }, /emision/));
    test("texture and texture-faces are mutually exclusive", () =>
        bad("block.schema.json", { texture: "a", "texture-faces": ["a", "a", "a", "a", "a", "a"] }));
    test("hitbox and hitboxes are mutually exclusive", () =>
        bad("block.schema.json", { hitbox: [0, 0, 0, 1, 1, 1], hitboxes: [[0, 0, 0, 1, 1, 1]] }));
    test("hitbox needs 6 numbers", () => bad("block.schema.json", { hitbox: [0, 0, 0, 1, 1] }, /hitbox/));
    test("emission components are 0..15 integers", () => bad("block.schema.json", { emission: [16, 0, 0] }));
    test("texture-faces needs 6 strings", () => bad("block.schema.json", { "texture-faces": ["a", "b"] }));
    test("unknown enum value", () => bad("block.schema.json", { rotation: "spin" }, /rotation/));
    test("custom model needs a model-name", () => {
        bad("block.schema.json", { model: "custom" });
        good("block.schema.json", { model: "custom", "model-name": "base:x" });
        good("block.schema.json", { model: "custom", parent: "base:stairs" });
    });
    test("too many state-based variants", () =>
        bad("block.schema.json", { "state-based": { variants: Array.from({ length: 16 }, () => ({})) } }));
    test("variants only accept variant properties", () =>
        bad("block.schema.json", { "state-based": { variants: [{ obstacle: false }] } }, /obstacle/));
    test("field types", () => {
        good("block.schema.json", { fields: { a: { type: "int8" }, b: { type: "char", length: 16, "convert-strategy": "clamp" } } });
        bad("block.schema.json", { fields: { a: { type: "int128" } } });
        bad("block.schema.json", { fields: { ".a": { type: "int8" } } });
    });
    test("methods and user properties", () => {
        good("block.schema.json", { "tags@append": ["x:y"], "base:durability": 2, "mypack:prop": { any: 1 }, "mypack:list@append": 1 });
        bad("block.schema.json", { "tags@prepend": ["x:y"] });
        bad("block.schema.json", { "obstacle@append": true });
    });
    test("particles inside a block", () => {
        good("block.schema.json", { particles: { lifetime: 1, spawn_shape: "box", velocity: [0, 1, 0] } });
        bad("block.schema.json", { particles: { spawn_shape: "cube" } });
        bad("block.schema.json", { particles: { velocity: [0, 1] } });
    });
    test("item enums", () => {
        good("item.schema.json", { "icon-type": "sprite", "uses-display": "relation", uses: 10 });
        bad("item.schema.json", { "icon-type": "png" });
        bad("item.schema.json", { "uses-display": "bar" });
    });
    test("entity shapes", () => {
        good("entity.schema.json", {
            components: ["base:drop", { name: "base:x", args: { a: 1 } }],
            sensors: [["radius", 1.5], ["aabb", 0, 0, 0, 1, 1, 1]],
            hitbox: [0.6, 1.8, 0.6],
            "body-type": "kinematic",
        });
        bad("entity.schema.json", { hitbox: [0, 0, 0, 1, 1, 1] });
        bad("entity.schema.json", { sensors: [["sphere", 1]] });
        bad("entity.schema.json", { components: [{ args: {} }] });
        bad("entity.schema.json", { tags: ["a"] });
    });
    test("package.json id and dependencies", () => {
        good("package.schema.json", { id: "my_pack", dependencies: ["base", "!a_b", "?opt", "~weak", "randutil@>=1.0", "x1@1.2"] });
        bad("package.schema.json", { id: "1pack" });
        bad("package.schema.json", { id: "a" });
        bad("package.schema.json", { id: "abcdefghijklmnopqrstuvwxy" });
        bad("package.schema.json", { id: "core" });
        bad("package.schema.json", { id: "my-pack" });
        bad("package.schema.json", { title: "no id" });
        bad("package.schema.json", { id: "ok", dependencies: ["#bad"] });
        bad("package.schema.json", { id: "ok", dependencies: ["a@"] });
    });
    test("generator config", () => {
        bad("generator.schema.json", { "biomes-bpd": 4 }, /biomes-bpd/);
        bad("generator.schema.json", { "heights-interpolation": "bilinear" });
        bad("biomes.schema.json", { forest: { parameters: [], layers: [{ block: "a" }], "sea-layers": [] } }, /height/);
        bad("biomes.schema.json", { forest: { parameters: [], layers: [], "sea-layers": [], plants: [{ block: "a", weight: 0 }] } });
    });
    test("bindings", () => {
        good("bindings.schema.json", { movement: { jump: "key:space", attack: "mouse:left", x: "key:f12" } });
        bad("bindings.schema.json", { movement: { jump: "key:spacebar" } });
        bad("bindings.schema.json", { movement: { jump: "gamepad:a" } });
    });
    test("preload entries", () => {
        good("preload.schema.json", { sounds: ["a", { name: "b", "keep-pcm": true }], atlases: [{ name: "c", type: "separate" }] });
        bad("preload.schema.json", { sounds: [{ name: "b", squash: true }] });
        bad("preload.schema.json", { sound: ["a"] });
        bad("preload.schema.json", { models: [{ path: "x" }] });
    });
    test("project permissions", () => {
        good("project.schema.json", { name: "p", permissions: ["network", "debugging"] });
        bad("project.schema.json", { permissions: ["root"] });
    });
    test("user props must be namespaced", () => {
        good("user-props.schema.json", { "base:durability": {} });
        bad("user-props.schema.json", { durability: {} });
    });
});
