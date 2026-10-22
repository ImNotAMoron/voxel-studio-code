import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ContentIndex } from "../../shared/content/index";
import { codeLenses, prepareRename, toWorkspaceEdit, willRenameFiles, workspaceSymbols } from "../../server/src/features/navigation";
import { ContentSymbol, RenamePlan, ReferenceIndex, extractRefs, namePosition, symbolOfFile } from "../../server/src/features/references";
import { BACKROOMS, ERRPACK, GOODPACK, RES, lintDirs } from "./helpers";

const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK, ERRPACK] });
const refs = new ReferenceIndex(() => index);
const readText = (file: string) => {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
};

function symbol(rel: string, idx = index): ContentSymbol {
    const s = symbolOfFile(idx, path.join(GOODPACK, rel));
    assert.ok(s, `no symbol for ${rel}`);
    return s;
}

/** "file: value" of each reference, relative to the packs folder. */
function found(s: ContentSymbol, r = refs): string[] {
    return r.references(s).map((x) => `${path.relative(path.dirname(GOODPACK), x.file).split(path.sep).join("/")}: ${x.value}`).sort();
}

test("extraction: JSON keys, unit ids anywhere, Lua calls, TOML and VCM textures", () => {
    const kinds = (rel: string) => {
        const file = path.join(GOODPACK, rel);
        return extractRefs(index, file, fs.readFileSync(file, "utf8")).map((r) => `${r.kind} ${r.value}`);
    };
    assert.deepEqual(kinds("blocks/crate.json"), ["blockTexture crate", "material goodpack:wood", "blockTexture crate_open"]);
    assert.deepEqual(kinds("tags.toml"), ["unit goodpack:crate", "unit base:planks", "unit goodpack:wand"]);
    assert.deepEqual(kinds("scripts/world.lua").slice(0, 3), ["module util", "module base:util", "block goodpack:crate"]);
    assert.deepEqual(kinds("models/statue.vcm"), ["atlasTexture blocks:crate"]);
    // offsets point at the string contents
    const file = path.join(GOODPACK, "blocks", "crate.json");
    const text = fs.readFileSync(file, "utf8");
    for (const r of extractRefs(index, file, text)) assert.equal(text.slice(r.start, r.end), r.value);
});

test("references resolve like go-to-definition, across file kinds", () => {
    assert.deepEqual(found(symbol("blocks/crate.json")), [
        "goodpack/blocks/crate_open.json: goodpack:crate.item",
        "goodpack/generators/plains.files/biomes.toml: goodpack:crate",
        "goodpack/scripts/world.lua: goodpack:crate",
        "goodpack/tags.toml: goodpack:crate",
    ]);
    const texture = found(symbol("textures/blocks/crate.png"));
    assert.equal(texture.length, 10);
    assert.ok(texture.includes("goodpack/models/statue.vcm: blocks:crate"));
    assert.ok(texture.includes("goodpack/blocks/statue.json: blocks:crate"));
    // bare `require "util"` is the caller's pack; `base:util` is another module
    assert.deepEqual(found(symbol("modules/util.lua")), [
        "goodpack/generators/plains.files/script.lua: goodpack:util",
        "goodpack/scripts/world.lua: util",
    ]);
    // sound variants fold into one symbol
    assert.deepEqual(symbol("sounds/crate/open_1.ogg").id, "crate/open");
    assert.deepEqual(found(symbol("sounds/crate/open_0.ogg")), [
        "goodpack/block_materials/wood.json: crate/open",
        "goodpack/preload.json: crate/open",
        "goodpack/scripts/crate.lua: crate/open",
    ]);
    assert.deepEqual(found(symbol("scripts/components/golem_ai.lua")), ["goodpack/entities/golem.json: goodpack:golem_ai"]);
    assert.deepEqual(found(symbol("models/statue.vcm")), ["goodpack/blocks/statue.json: statue", "goodpack/skeletons/golem.json: statue"]);
    // built-in units are found in workspace packs and in res/
    const stone = symbolOfFile(index, path.join(RES, "content", "base", "blocks", "stone.json"))!;
    const stoneRefs = found(stone);
    assert.ok(stoneRefs.includes("goodpack/generators/plains.files/script.lua: base:stone"));
    assert.ok(stoneRefs.some((r) => r.includes("base/entities/drop.json: base:stone.item")));
});

test("namePosition only matches whole name segments", () => {
    assert.equal(namePosition("goodpack:crate", "crate"), 9);
    assert.equal(namePosition("goodpack:crate.item", "crate"), 9);
    assert.equal(namePosition("blocks:crate", "crate"), 7);
    assert.equal(namePosition("crate/open", "open"), 6);
    assert.equal(namePosition("crate:crate_open", "crate"), -1);
    assert.equal(namePosition("statue.part", "statue"), 0);
});

test("rename plans: files, linked defaults, refusals", () => {
    const plan = refs.planRename(symbol("blocks/crate.json"), "box") as RenamePlan;
    assert.equal(typeof plan, "object", String(plan));
    // the default script (no script-name) and ui-layout (defaults to the block id) move along
    assert.deepEqual(plan.renames.map((r) => `${path.basename(r.from)} → ${path.basename(r.to)}`), [
        "crate.json → box.json", "crate.lua → box.lua", "crate.xml → box.xml", "crate.xml.lua → box.xml.lua",
    ]);
    assert.ok(plan.unit);
    assert.equal(plan.edits.size, 4);
    // an item with an explicit script-name keeps its script
    const wand = refs.planRename(symbol("items/wand.json"), "staff") as RenamePlan;
    assert.deepEqual(wand.renames.map((r) => path.basename(r.to)), ["staff.json"]);
    // sounds rename every variant
    const sound = refs.planRename(symbol("sounds/crate/open_0.ogg"), "creak") as RenamePlan;
    assert.deepEqual(sound.renames.map((r) => path.basename(r.to)), ["creak_0.ogg", "creak_1.ogg"]);
    assert.equal(sound.unit, false);

    assert.match(String(refs.planRename(symbol("scripts/crate.lua"), "x")), /default script of goodpack:crate; rename the block instead/);
    assert.match(String(refs.planRename(symbol("layouts/crate.xml"), "x")), /default layout of goodpack:crate/);
    assert.match(String(refs.planRename(symbol("blocks/crate.json"), "crate_open")), /crate_open\.json already exists/);
    assert.match(String(refs.planRename(symbol("blocks/crate.json"), "a b")), /not a valid name/);
    const stone = symbolOfFile(index, path.join(RES, "content", "base", "blocks", "stone.json"))!;
    assert.match(String(refs.planRename(stone, "rock")), /built-in pack 'base'/);
});

function copyPack(): { dir: string; pack: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-rename-"));
    const pack = path.join(dir, "goodpack");
    fs.cpSync(GOODPACK, pack, { recursive: true });
    return { dir, pack };
}

/** Applies a plan like VS Code does: text edits first (end to start), then file renames. */
function apply(plan: RenamePlan) {
    for (const [file, edits] of plan.edits) {
        let text = fs.readFileSync(file, "utf8");
        for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.newText + text.slice(e.end);
        fs.writeFileSync(file, text);
    }
    for (const r of plan.renames) fs.renameSync(r.from, r.to);
}

const problems = (dir: string) =>
    lintDirs([dir]).diagnostics.filter((d) => d.severity === "error" || d.severity === "warning").map((d) => `${path.basename(d.file)} ${d.code} ${d.message}`).sort();

test("applied renames leave no dangling references (block, texture, sound, model, module)", () => {
    const { dir, pack } = copyPack();
    try {
        // content.json keeps the unit's position
        fs.writeFileSync(path.join(pack, "content.json"), JSON.stringify({ blocks: ["crate", "crate_open", "statue", "tall"], items: [], entities: [] }, null, 4));
        const before = problems(pack);
        const renames: [string, string][] = [
            ["blocks/crate.json", "box"],
            ["textures/blocks/crate_open.png", "box_open"],
            ["sounds/crate/open_0.ogg", "creak"],
            ["models/statue.vcm", "idol"],
            ["modules/util.lua", "helpers"],
            ["entities/golem.json", "bot"],
        ];
        for (const [rel, name] of renames) {
            const idx = new ContentIndex({ resPath: RES, packDirs: [pack] });
            const r = new ReferenceIndex(() => idx);
            const s = symbolOfFile(idx, path.join(pack, rel));
            assert.ok(s, rel);
            const plan = r.planRename(s, name);
            assert.equal(typeof plan, "object", `${rel}: ${plan}`);
            apply(plan as RenamePlan);
        }
        assert.deepEqual(problems(pack), before);
        const idx = new ContentIndex({ resPath: RES, packDirs: [pack] });
        assert.ok(idx.blocks.has("goodpack:box") && !idx.blocks.has("goodpack:crate"));
        assert.ok(fs.existsSync(path.join(pack, "scripts", "box.lua")) && fs.existsSync(path.join(pack, "layouts", "box.xml.lua")));
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pack, "content.json"), "utf8")).blocks, ["box", "crate_open", "statue", "tall"]);
        const all = fs.readFileSync(path.join(pack, "tags.toml"), "utf8") + fs.readFileSync(path.join(pack, "scripts", "world.lua"), "utf8");
        assert.ok(!all.includes("goodpack:crate\"") && all.includes("goodpack:box"));
        assert.match(fs.readFileSync(path.join(pack, "scripts", "world.lua"), "utf8"), /require "helpers"/);
        // the entity's skeleton defaults to its id only without skeleton-name, which golem sets
        assert.match(fs.readFileSync(path.join(pack, "scripts", "wand.lua"), "utf8"), /"goodpack:bot"/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("LSP edits: annotated unit renames, prepareRename ranges, willRenameFiles, symbols, lenses", () => {
    const plan = refs.planRename(symbol("blocks/crate.json"), "box") as RenamePlan;
    const edit = toWorkspaceEdit(plan, readText);
    const changes = edit.documentChanges!;
    // text edits come before file renames
    const firstRename = changes.findIndex((c) => "kind" in c);
    assert.ok(firstRename > 0 && changes.slice(firstRename).every((c) => "kind" in c));
    assert.ok(edit.changeAnnotations!["voxelcore.unitRename"].needsConfirmation);

    const world = path.join(GOODPACK, "scripts", "world.lua");
    const text = fs.readFileSync(world, "utf8");
    const doc = TextDocument.create("file:///w", "lua", 1, text);
    const prep = prepareRename(refs, doc, world, text.indexOf("goodpack:crate") + 3);
    assert.ok("range" in prep, JSON.stringify(prep));
    assert.equal(prep.placeholder, "crate");
    assert.equal(text.slice(doc.offsetAt(prep.range.start), doc.offsetAt(prep.range.end)), "crate");
    assert.ok(!("range" in prepareRename(refs, doc, world, 0)));

    // Explorer rename of a texture: references follow, no file operations
    const png = path.join(GOODPACK, "textures", "blocks", "crate_open.png");
    const will = willRenameFiles(refs, [{ from: png, to: path.join(path.dirname(png), "lid.png") }], readText)!;
    assert.ok(will.documentChanges!.every((c) => !("kind" in c)));
    const newTexts = will.documentChanges!.flatMap((c) => ("edits" in c ? c.edits.map((e) => ("newText" in e ? e.newText : "")) : []));
    assert.deepEqual(newTexts, ["lid", "lid"]);
    // moving to another folder isn't a rename of the id
    assert.equal(willRenameFiles(refs, [{ from: png, to: path.join(GOODPACK, "lid.png") }], readText), null);

    const names = workspaceSymbols(refs, "crate").map((s) => s.name);
    assert.ok(names.includes("goodpack:crate") && names.includes("blocks:crate") && names.includes("crate/open"));
    assert.ok(!workspaceSymbols(refs, "").some((s) => s.name.startsWith("core:internal/")));

    const lens = codeLenses(refs, path.join(GOODPACK, "blocks", "crate.json"), readText);
    assert.equal(lens[0].command!.title, "4 references");
    const scriptLens = codeLenses(refs, path.join(GOODPACK, "scripts", "crate.lua"), readText);
    assert.deepEqual(scriptLens.map((l) => l.command!.title), ["0 references", "script of goodpack:crate"]);
});

test("references in a real pack: every backrooms texture and block is found", () => {
    const idx = new ContentIndex({ resPath: RES, packDirs: [BACKROOMS] });
    const r = new ReferenceIndex(() => idx);
    const pd = idx.getPackData("backrooms")!;
    const unreferenced: string[] = [];
    for (const [key, file] of pd.textures) {
        if (!key.startsWith("blocks/")) continue;
        if (!r.references(symbolOfFile(idx, file)!).length) unreferenced.push(key);
    }
    // the linter's VC0060 (unused texture) agrees
    const unused = lintDirs([BACKROOMS]).diagnostics.filter((d) => d.code === "VC0060").map((d) => d.message);
    assert.equal(unreferenced.length, unused.length, `${unreferenced.join(", ")} vs ${unused.join(" | ")}`);
});
