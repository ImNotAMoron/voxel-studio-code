import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ContentIndex, checkPackId, parseDependency, versionSatisfies, detectResPath } from "../../shared/content/index";
import { BACKROOMS, BASE, GOODPACK, REPO_ROOT, RES } from "./helpers";

const index = new ContentIndex({ resPath: RES, packDirs: [BACKROOMS, GOODPACK] });

test("discovers core, builtin and explicit packs", () => {
    assert.ok(index.packs.has("core"));
    assert.equal(index.packs.get("core")!.builtin, true);
    assert.equal(index.packs.get("base")!.builtin, true);
    assert.equal(index.packs.get("backrooms")!.builtin, false);
    assert.deepEqual(index.packs.get("backrooms")!.dependencies, ["base"]);
    assert.equal(index.packs.get("backrooms")!.dependencyInfo[0].level, "required");
});

test("blocks, implicit items and hidden blocks", () => {
    assert.ok(index.blocks.has("base:stone"));
    assert.ok(index.items.has("base:stone.item"), "implicit block item");
    assert.equal(index.items.get("base:stone.item")!.blockOf, "base:stone");
    assert.ok(index.blocks.has("backrooms:carpet_1"));
    assert.ok(!index.items.has("backrooms:carpet_1.item"), "hidden blocks have no item");
    assert.ok(index.items.has("base:bazalt_breaker"));
    assert.ok(index.entities.has("base:drop"));
    assert.ok(index.blocks.has("core:air") && index.items.has("core:empty"));
});

test("subfolder definitions override other packs' units", () => {
    const glass = index.blocks.get("base:glass")!;
    assert.equal(glass.pack, "base");
    assert.equal(glass.overrides.length, 1);
    assert.equal(glass.overrides[0].pack, "goodpack");
    assert.ok(!index.blocks.has("goodpack:glass"));
});

test("leading underscore files are skipped", () => {
    assert.ok(!index.blocks.has("goodpack:_draft"));
    assert.equal(index.getPackData("goodpack")!.skippedDefs.length, 1);
});

test("asset resolution", () => {
    assert.ok(index.resolveTexture("blocks", "stone")?.endsWith(path.join("textures", "blocks", "stone.png")));
    assert.ok(index.resolveTexture("blocks", "notfound"), "core texture");
    assert.ok(index.resolveTextureRef("items:bazalt_breaker"));
    assert.ok(index.resolveTextureRef("misc/moon"), "standalone texture by path");
    assert.equal(index.resolveTexture("blocks", "nope"), undefined);
    assert.ok(index.resolveSound("steps/stone"), "variant rule name_0");
    assert.ok(index.resolveSound("blocks/door_open"), "plain name");
    assert.ok(index.resolveSound("blocks/metal_place"));
    assert.equal(index.resolveSound("steps/nope"), undefined);
    assert.ok(index.soundNames().has("ambient/rain"));
    assert.ok(!index.soundNames().has("ambient/rain_1"));
    assert.ok(index.resolveModel("drop-item")?.endsWith("drop-item.vec3"), "core model");
    assert.ok(index.resolveModel("player-body.part"), "sub-model falls back to the file");
    assert.ok(index.resolveModel("statue", "goodpack")?.endsWith("statue.vcm"));
});

test("materials, skeletons, components, layouts, modules, generators", () => {
    assert.ok(index.resolveMaterial("base:stone"));
    assert.ok(index.resolveMaterial("backrooms:carpet"));
    assert.equal(index.resolveMaterial("stone"), undefined);
    assert.ok(index.resolveSkeleton("base:drop"));
    assert.ok(index.resolveComponent("base:drop"));
    assert.ok(index.resolveComponent("core:mob"), "core components from res/scripts/components");
    assert.ok(index.resolveLayout("core:inventory"));
    assert.ok(index.resolveLayout("goodpack:crate"));
    assert.ok(index.resolveModule("base:util"));
    assert.ok(index.resolveModule("util", "base"), "bare require resolves in the caller's pack");
    assert.ok(index.resolveModule("core:vector3") || index.resolveModule("res:vector3"));
    const demo = index.resolveGenerator("base:demo")!;
    assert.ok(demo.script && demo.biomesFile && demo.structuresFile);
    assert.ok(demo.structures.has("tower") && demo.fragments.has("tower"));
    assert.ok(demo.biomes.has("forest"));
    assert.ok(index.userProps().has("base:durability"));
    assert.ok(index.userProps().has("goodpack:weight"));
});

test("script users follow script-name and implicit item scripts", () => {
    assert.deepEqual(index.scriptUsers("base", "grass_block").map((u) => u.id), ["base:grass_block"]);
    assert.deepEqual(index.scriptUsers("goodpack", "wand").map((u) => u.id), ["goodpack:wand"]);
    assert.deepEqual(index.scriptUsers("base", "stone.item").map((u) => u.id), ["base:stone.item"]);
    assert.equal(index.scriptUsers("base", "world").length, 0);
});

test("packForFile picks the deepest pack", () => {
    assert.equal(index.packForFile(path.join(BASE, "blocks", "stone.json"))?.id, "base");
    assert.equal(index.packForFile(path.join(RES, "scripts", "stdlib.lua"))?.id, "core");
    assert.equal(index.packForFile(path.join(REPO_ROOT, "src", "main.cpp")), undefined);
});

test("workspace discovery skips fixtures/node_modules and detects res", () => {
    const ws = new ContentIndex({ roots: [REPO_ROOT] });
    assert.equal(ws.resPath, RES);
    assert.ok(ws.packs.has("backrooms"));
    assert.ok(!ws.packs.has("goodpack"), "fixtures are not part of the workspace scan");
    assert.ok(ws.lintablePacks().some((p) => p.id === "base"), "builtin packs inside the workspace are lintable");
    assert.ok(!ws.lintablePacks().some((p) => p.id === "core"));
    assert.equal(detectResPath(path.join(REPO_ROOT, "src")), RES);
});

test("incremental updates", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcls-index-"));
    const pack = path.join(tmp, "tmppack");
    fs.mkdirSync(path.join(pack, "blocks"), { recursive: true });
    fs.writeFileSync(path.join(pack, "package.json"), JSON.stringify({ id: "tmppack", version: "1.0" }));
    const idx = new ContentIndex({ resPath: RES, packDirs: [pack] });
    assert.ok(!idx.blocks.has("tmppack:thing"));
    const file = path.join(pack, "blocks", "thing.json");
    fs.writeFileSync(file, JSON.stringify({ hidden: true }));
    idx.updateFile(file);
    assert.ok(idx.blocks.has("tmppack:thing"));
    assert.ok(!idx.items.has("tmppack:thing.item"));
    idx.updateFile(file, '{"hidden": false}');
    assert.ok(idx.items.has("tmppack:thing.item"), "overlay text is used");
    fs.rmSync(file);
    idx.clearOverlay(file);
    idx.removeFile(file);
    assert.ok(!idx.blocks.has("tmppack:thing"));
    fs.rmSync(tmp, { recursive: true, force: true });
});

test("pack id and dependency rules", () => {
    assert.equal(checkPackId("base"), undefined);
    assert.match(checkPackId("a")!, /length/);
    assert.match(checkPackId("9abc")!, /digit/);
    assert.match(checkPackId("a-b")!, /illegal/);
    assert.match(checkPackId("core")!, /reserved/);
    const d = parseDependency("?randutil@>=1.2");
    assert.deepEqual([d.level, d.id, d.op, d.version, d.error], ["optional", "randutil", ">=", "1.2", undefined]);
    assert.equal(parseDependency("~x1@<2.0").op, "<");
    assert.equal(parseDependency("base").level, "required");
    assert.ok(parseDependency("").error);
    assert.ok(parseDependency("base@=1.0").error);
    assert.ok(versionSatisfies(parseDependency("base@>=0.30"), "0.32"));
    assert.ok(!versionSatisfies(parseDependency("base@>=1.0"), "0.32"));
    assert.ok(versionSatisfies(parseDependency("base@1.0-beta"), "1.0-beta"), "string fallback");
});
