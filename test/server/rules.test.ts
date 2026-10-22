import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex } from "../../shared/content/index";
import { createEnv, lintDocument } from "../../server/src/linter";
import { RULES } from "../../server/src/rules/registry";
import { checkVcaExpression } from "../../server/src/rules/vcm";
import { BACKROOMS, BASE, ERRPACK, FIXTURES, GOODPACK, RES, describe, lintDirs, rel } from "./helpers";

const err = lintDirs([ERRPACK, path.join(FIXTURES, "badid"), path.join(FIXTURES, "reserved")]);
const good = lintDirs([GOODPACK]);

function has(code: string, file: string, pattern?: RegExp) {
    const found = err.diagnostics.some((d) => d.code === code && rel(d.file) === file && (!pattern || pattern.test(d.message)));
    assert.ok(found, `expected ${code} in ${file}${pattern ? " matching " + pattern : ""}\n` +
        err.diagnostics.filter((d) => rel(d.file) === file).map(describe).join("\n"));
}

// [code, file relative to fixtures, message pattern?]
const EXPECTED: [string, string, RegExp?][] = [
    ["VC0001", "badid/package.json", /digit/],
    ["VC0001", "reserved/package.json", /reserved/],
    ["VC0002", "errpack/package.json"],
    ["VC0003", "errpack/package.json"],
    ["VC0004", "errpack/package.json", /'\?'/],
    ["VC0004", "errpack/package.json", /=1\.0/],
    ["VC0005", "errpack/package.json", /nosuchpack/],
    ["VC0005", "errpack/package.json", />=99\.0/],
    ["VC0006", "errpack/package.json"],
    ["VC0007", "errpack/items/broken.json"],
    ["VC0010", "errpack/blocks/bad.json", /did you mean 'texture'/],
    ["VC0010", "errpack/blocks/bad.json", /@prepend/],
    ["VC0011", "errpack/blocks/bad.json", /errpack_x:undeclared/],
    ["VC0020", "errpack/blocks/bad.json", /'nope'/],
    ["VC0020", "errpack/blocks/bad.json", /'nope2'/],
    ["VC0020", "errpack/blocks/hidden.json"],
    ["VC0021", "errpack/items/bad_item.json"],
    ["VC0021", "errpack/items/blockicon.json"],
    ["VC0021", "errpack/items/noatlas.json", /atlas:texture/],
    ["VC0022", "errpack/blocks/withmodel.json"],
    ["VC0023", "errpack/models/blockmodel.vcm"],
    ["VC0024", "errpack/blocks/bad.json"],
    ["VC0024", "errpack/blocks/scripted.json", /full id/],
    ["VC0025", "errpack/block_materials/badmat.json", /steps\/nope/],
    ["VC0026", "errpack/blocks/bad.json", /block item 'base:stone\.item'/],
    ["VC0026", "errpack/blocks/bad.json", /parent/],
    ["VC0026", "errpack/items/bad_item.json", /placing-block/],
    ["VC0027", "errpack/tags.toml", /base:nope/],
    ["VC0027", "errpack/tags.toml", /nocolon/],
    ["VC0028", "errpack/blocks/hidden.json"],
    ["VC0029", "errpack/blocks/solidinv.json"],
    ["VC0030", "errpack/blocks/bad.json"],
    ["VC0030", "errpack/items/bad_item.json"],
    ["VC0031", "errpack/entities/bad_entity.json", /nocomp/],
    ["VC0031", "errpack/entities/bad_entity.json", /nocolon/],
    ["VC0032", "errpack/entities/bad_entity.json"],
    ["VC0032", "errpack/entities/bad_entity2.json"],
    ["VC0033", "errpack/skeletons/badskel.json"],
    ["VC0034", "errpack/skeletons/badskel.json"],
    ["VC0035", "errpack/generators/broken.files/structures.toml"],
    ["VC0036", "errpack/generators/broken.toml", /heightmap-inputs/],
    ["VC0036", "errpack/generators/nobiomes.toml", /biome/],
    ["VC0036", "errpack/generators/broken.files/biomes.toml", /base:nope/],
    ["VC0036", "errpack/generators/broken.files/biomes.toml", /ghost/],
    ["VC0037", "errpack/generators/broken.files/biomes.toml"],
    ["VC0038", "errpack/generators/broken.files/biomes.toml"],
    ["VC0039", "errpack/preload.json", /nope\/sound/],
    ["VC0039", "errpack/preload.json", /layouts/],
    ["VC0039", "errpack/preload.json", /'foo'/],
    ["VC0040", "errpack/blocks/withmodel2.json"],
    ["VC0050", "errpack/blocks/bad.json"],
    ["VC0051", "errpack/blocks/bad.json"],
    ["VC0052", "errpack/blocks/bad.json", /248\/240/],
    ["VC0053", "errpack/blocks/bad.json"],
    ["VC0054", "errpack/blocks/bad.json"],
    ["VC0055", "errpack/blocks/solidinv.json"],
    ["VC0056", "errpack/blocks/hidden.json", /6 elements/],
    ["VC0057", "errpack/blocks/custom.json"],
    ["VC0058", "errpack/blocks/custom.json"],
    ["VC0060", "errpack/textures/blocks/unused_tex.png"],
    ["VC0061", "errpack/sounds/unused_snd.ogg"],
    ["VC0062", "errpack/models/lonely.vcm"],
    ["VC0063", "errpack/scripts/orphan.lua"],
    ["VC0100", "errpack/scripts/syntax.lua"],
    ["VC0101", "errpack/scripts/scripted.lua", /Did you mean 'on_placed'/],
    ["VC0101", "errpack/scripts/scripted.lua", /item script/],
    ["VC0101", "errpack/scripts/world.lua", /on_world_open/],
    ["VC0101", "errpack/scripts/components/comp.lua", /on_update/],
    ["VC0101", "errpack/generators/broken.files/script.lua", /generate_heightmap/],
    ["VC0102", "errpack/generators/broken.files/script.lua", /'player'/],
    ["VC0102", "errpack/generators/broken.files/script.lua", /'world'/],
    ["VC0103", "errpack/scripts/scripted.lua", /nomodule/],
    ["VC0103", "errpack/scripts/scripted.lua", /omit the \.lua/],
    ["VC0104", "errpack/modules/noreturn.lua"],
    ["VC0105", "errpack/scripts/scripted.lua", /block_index/],
    ["VC0106", "errpack/scripts/scripted.lua"],
    ["VC0200", "errpack/models/bad.vcm"],
    ["VC0201", "errpack/models/bad.vcm", /@sphere/],
    ["VC0201", "errpack/models/bad.vcm", /only used inside @box/],
    ["VC0202", "errpack/models/bad.vcm", /colour/],
    ["VC0203", "errpack/models/bad.vcm", /got 2/],
    ["VC0203", "errpack/models/bad.vcm", /'uv'/],
    ["VC0204", "errpack/models/bad.vcm", /cull-face/],
    ["VC0204", "errpack/models/bad.vcm", /flip/],
    ["VC0204", "errpack/models/bad.vcm", /shading/],
    ["VC0204", "errpack/models/bad.vcm", /'up'/],
    ["VC0205", "errpack/models/bad.vcm", /blocks:nope/],
    ["VC0205", "errpack/models/bad.vcm", /\$x/],
    ["VC0206", "errpack/models/bad.vcm"],
    ["VC0207", "errpack/models/bad.vcm"],
    ["VC0208", "errpack/models/bad.vcm"],
    ["VC0209", "errpack/models/bad.vcm", /'from'/],
    ["VC0220", "errpack/animation/bad.vca", /@spin/],
    ["VC0221", "errpack/animation/bad.vca", /bogus/],
    ["VC0221", "errpack/animation/bad.vca", /@frame/],
    ["VC0222", "errpack/animation/bad.vca"],
    ["VC0223", "errpack/animation/bad.vca", /wobbly/],
    ["VC0223", "errpack/animation/bad.vca", /nocurve/],
    ["VC0224", "errpack/animation/bad.vca", /sinn/],
    ["VC0224", "errpack/animation/bad.vca", /'rand'/],
    ["VC0224", "errpack/animation/bad.vca", /'e'/],
    ["VC0224", "errpack/animation/bad.vca", /'\.\.'/],
    ["VC0225", "errpack/animation/bad.vca", /tangents/],
    ["VC0226", "errpack/animation/bad.vca"],
    ["VC0300", "errpack/texts/de_DE.txt", /non-closed string literal/],
    ["VC0301", "errpack/texts/ru_RU.txt", /'shared': line 3 overrides/],
    ["VC0302", "errpack/texts/xx_XX.txt", /never loaded/],
    ["VC0303", "errpack/texts/ru_RU.txt", /'only_de'/],
    ["VC0304", "errpack/texts/ru_RU.txt", /'bad'/],
];

for (const [code, file, pattern] of EXPECTED) {
    test(`${code} fires: ${file}${pattern ? " " + pattern : ""}`, () => has(code, file, pattern));
}

test("every rule has a positive fixture", () => {
    const covered = new Set(EXPECTED.map(([code]) => code));
    covered.add("VC0012"); // goodpack/_draft.json (below)
    covered.add("VC0013"); // content.json (below)
    const missing = [...RULES.keys()].filter((id) => !covered.has(id));
    assert.deepEqual(missing, []);
});

test("goodpack (negative fixture) is clean apart from deliberate hints", () => {
    const noisy = good.diagnostics.filter((d) => !(d.code === "VC0012" && d.file.endsWith("_draft.json")) &&
        !(d.code === "VC0208" && d.file.endsWith("statue.vcm")));
    assert.deepEqual(noisy.map(describe), []);
    assert.ok(good.diagnostics.some((d) => d.code === "VC0012"));
});

test("no diagnostic is reported twice", () => {
    const keys = err.diagnostics.map((d) => `${d.file}:${d.start}:${d.end}:${d.code}:${d.message}`);
    assert.equal(new Set(keys).size, keys.length);
});

test("JSON diagnostics point at the exact value range", () => {
    const d = err.diagnostics.find((x) => x.code === "VC0020" && x.message.includes("'nope'"))!;
    const text = fs.readFileSync(d.file, "utf8");
    assert.equal(text.slice(d.start, d.end), '"nope"');
    const k = err.diagnostics.find((x) => x.code === "VC0011")!;
    assert.equal(fs.readFileSync(k.file, "utf8").slice(k.start, k.end), '"errpack_x:undeclared"');
});

test("TOML diagnostics point at the string / key", () => {
    const d = err.diagnostics.find((x) => x.code === "VC0036" && x.message.includes("base:nope"))!;
    assert.equal(fs.readFileSync(d.file, "utf8").slice(d.start, d.end), '"base:nope"');
    const s = err.diagnostics.find((x) => x.code === "VC0035")!;
    assert.equal(fs.readFileSync(s.file, "utf8").slice(s.start, s.end), "ruin");
});

test("editor mode leaves unknown keys to the JSON schema service", () => {
    const editor = lintDirs([ERRPACK], { editor: true });
    assert.ok(!editor.diagnostics.some((d) => d.code === "VC0010" && /unknown property 'texure'/.test(d.message)));
    assert.ok(editor.diagnostics.some((d) => d.code === "VC0011"), "user props are still checked");
    assert.ok(!editor.diagnostics.some((d) => d.code === "VC0007"), "JSON syntax is left to VS Code");
});

test("content.json edited in the editor", () => {
    const index = new ContentIndex({ resPath: RES, packDirs: [ERRPACK] });
    const env = createEnv(index, {}, true);
    const file = path.join(ERRPACK, "content.json");
    const text = fs.readFileSync(file, "utf8");
    assert.equal(lintDocument(env, file, text).length, 0);
    const edited = lintDocument(env, file, text, { contentJsonEdited: true });
    assert.deepEqual(edited.map((d) => d.code), ["VC0013"]);
});

test("severity overrides and 'off'", () => {
    const index = new ContentIndex({ resPath: RES, packDirs: [ERRPACK] });
    const file = path.join(ERRPACK, "blocks", "bad.json");
    const text = fs.readFileSync(file, "utf8");
    const env = createEnv(index, { rules: { VC0020: "off", VC0051: "error" } }, true);
    const list = lintDocument(env, file, text);
    assert.ok(!list.some((d) => d.code === "VC0020"));
    assert.equal(list.find((d) => d.code === "VC0051")!.severity, "error");
});

test("VCA expressions", () => {
    assert.deepEqual(checkVcaExpression("sin(t * 2.5) + pi", false), []);
    assert.deepEqual(checkVcaExpression("kl.value + (kr.value - kl.value) * t", true), []);
    assert.equal(checkVcaExpression("sinn(t)", false)[0].start, 0);
    assert.match(checkVcaExpression("noise2d(t, 1, 2)", false)[0].message, /noise2/);
    assert.match(checkVcaExpression("t +", false)[0].message, /invalid expression/);
    assert.match(checkVcaExpression("blend(t)", false)[0].message, /'end'/);
});

for (const [name, dir] of [["base", BASE], ["backrooms", BACKROOMS]] as const) {
    test(`zero noise on ${name}: no errors or warnings`, () => {
        const { diagnostics } = lintDirs([dir]);
        const noisy = diagnostics.filter((d) => d.severity === "error" || d.severity === "warning");
        assert.deepEqual(noisy.map(describe), []);
        // only deliberate hints/infos: icon size, unused assets, untranslated captions
        // (base: 'coal ore' has no translation, ENGINE_NOTES.md)
        for (const d of diagnostics) assert.ok(["VC0006", "VC0060", "VC0061", "VC0062", "VC0063", "VC0012", "VC0208", "VC0304"].includes(d.code), describe(d));
    });
}
