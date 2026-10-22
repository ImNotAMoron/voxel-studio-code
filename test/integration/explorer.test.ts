import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ContentIndex, parseDependency } from "../../shared/content/index";
import { assemblePacks, type AssemblePack } from "../../shared/content/assemble";
import { Locales, blockIcon, explorerPacks, idToCaption, itemIcon, packCategories, packDependencies, unitCaption } from "../../src/explorer/model";
import { BACKROOMS, BASE, RES } from "../server/helpers";

const index = new ContentIndex({ resPath: RES, packDirs: [BACKROOMS] });

const pack = (id: string, deps: string[] = [], version = "1.0"): [string, AssemblePack] => [
    id,
    { id, version, dependencyInfo: deps.map(parseDependency) },
];

test("idToCaption mirrors util::id_to_caption", () => {
    assert.equal(idToCaption("base:grass_block"), "grass block");
    assert.equal(idToCaption("base:__hidden_name"), "__hidden name");
    assert.equal(idToCaption("base:"), "");
    assert.equal(idToCaption("nocolon"), "");
});

test("load order: dependencies first, weak ones only ordered when enabled", () => {
    const packs = new Map([pack("a", ["b", "?c"]), pack("b", ["d"]), pack("d"), pack("w", ["~a"])]);
    assert.deepEqual(assemblePacks(["a"], packs), { order: ["d", "b", "a"] });
    // weak: not pulled in
    assert.deepEqual(assemblePacks(["w"], packs), { order: ["w"] });
    // weak deps are skipped from the second pass on, so they don't order anything:
    // the engine loads w before its weak dependency a (ENGINE_NOTES.md)
    assert.deepEqual(assemblePacks(["w", "a"], packs).order, ["d", "w", "b", "a"]);
});

test("load order errors use the engine's messages", () => {
    const packs = new Map([pack("a", ["missing"]), pack("x", ["y"]), pack("y", ["x"]), pack("v", ["b@>=2.0"]), pack("b", [], "1.5")]);
    assert.deepEqual(assemblePacks(["a"], packs).error, { pack: "missing", message: "dependency of 'a'" });
    assert.match(assemblePacks(["x"], packs).error!.message, /^circular dependency: /);
    assert.deepEqual(assemblePacks(["v"], packs).error, { pack: "b", message: "does not meet required version '>=2.0' of 'v'" });
    assert.deepEqual(assemblePacks(["nope"], packs).error, { pack: "nope", message: "pack not found" });
});

test("explorer lists workspace packs first and built-ins separately", () => {
    const { workspace, builtin } = explorerPacks(index);
    assert.deepEqual(workspace.map((p) => p.id), ["backrooms"]);
    assert.equal(builtin[0].id, "core");
    assert.ok(builtin.some((p) => p.id === "base"));
});

test("pack categories with icons and captions", () => {
    const cats = packCategories(index, "base");
    const keys = cats.map((c) => c.key);
    for (const key of ["blocks", "items", "entities", "models", "textures", "sounds", "scripts", "generators"]) {
        assert.ok(keys.includes(key), `missing ${key}: ${keys.join(",")}`);
    }
    const blocks = cats.find((c) => c.key === "blocks")!.entries;
    const grass = blocks.find((e) => e.label === "grass_block")!;
    assert.equal(grass.id, "base:grass_block");
    assert.equal(grass.description, "grass block");
    // texture-faces → top face (+Y, index 3)
    assert.equal(grass.icon, path.join(BASE, "textures", "blocks", "grass_top.png"));
    // implicit block items aren't listed
    assert.ok(!cats.find((c) => c.key === "items")!.entries.some((e) => e.label.endsWith(".item")));
    const textures = cats.find((c) => c.key === "textures")!;
    assert.ok(textures.folders!.has("blocks") && textures.folders!.has("items"));
});

test("item icons: sprites, block icons and implicit block items", () => {
    const breaker = index.items.get("base:bazalt_breaker")!;
    assert.equal(itemIcon(index, breaker), path.join(BASE, "textures", "items", "bazalt_breaker.png"));
    assert.equal(itemIcon(index, index.items.get("base:stone.item")!), blockIcon(index, index.blocks.get("base:stone")!));
    assert.equal(blockIcon(index, index.blocks.get("core:air")!), undefined);
});

test("captions are translated from the packs' texts/<lang>.txt", () => {
    const ru = new Locales(index, "ru");
    assert.equal(unitCaption(index, index.blocks.get("base:grass_block")!, ru), "дёрн");
    assert.equal(unitCaption(index, index.items.get("base:grass_block.item")!, ru), "дёрн", "block items use the block caption");
    assert.equal(unitCaption(index, index.blocks.get("base:grass_block")!, new Locales(index, "en")), "grass block");
});

test("dependencies of a workspace pack", () => {
    const deps = packDependencies(index, index.packs.get("backrooms")!);
    assert.deepEqual(deps.dependencies.map((d) => [d.id, d.status]), [["base", "ok"]]);
    assert.deepEqual(deps.order, ["core", "base", "backrooms"]);
    assert.equal(deps.error, undefined);
});
