import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex, grantPermissionEdit } from "../../shared/content/index";
import { createEnv, lintDocument } from "../../server/src/linter";
import { RULES } from "../../server/src/rules/registry";
import { checkVcaExpression } from "../../server/src/rules/vcm";
import { BACKROOMS, BASE, ERRPACK, FIXTURES, GOODPACK, RES, describe, lintDirs, lintProjectDir, rel } from "./helpers";

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
    ["VC0400", "errpack/layouts/broken.xml", /string literal expected/],
    ["VC0401", "errpack/layouts/bad.xml", /'buton'.*did you mean <button>/],
    ["VC0401", "errpack/layouts/bad.xml", /<option> is only read inside <select>/],
    ["VC0402", "errpack/layouts/bad.xml", /'orientaton'.*did you mean 'orientation'/],
    ["VC0402", "errpack/layouts/bad.xml", /<container> doesn't read 'interval'.*only <panel>/],
    ["VC0403", "errpack/layouts/bad.xml", /<image> is ignored: <label> doesn't read child elements/],
    ["VC0403", "errpack/layouts/bad.xml", /<label> is ignored: <select> reads only <option>/],
    ["VC0403", "errpack/layouts/bad.xml", /this text is ignored: <panel>/],
    ["VC0403", "errpack/layouts/bad.xml", /<slots-grid> is ignored here/],
    ["VC0404", "errpack/layouts/bad.xml", /'id' is set again/],
    ["VC0405", "errpack/layouts/values.xml", /margin: invalid vec4 value/],
    ["VC0405", "errpack/layouts/values.xml", /tooltip-delay: 'soon' isn't a number/],
    ["VC0405", "errpack/layouts/values.xml", /track-width: an empty value isn't an integer/],
    ["VC0405", "errpack/layouts/values.xml", /color: a numeric colour needs r,g,b,a/],
    ["VC0405", "errpack/layouts/values.xml", /color: #RRGGBB or #RRGGBBAA required/],
    ["VC0406", "errpack/layouts/values.xml", /orientation: 'Horizontal'.*did you mean 'horizontal'/],
    ["VC0406", "errpack/layouts/values.xml", /gravity: 'center'.*no automatic positioning/],
    ["VC0406", "errpack/layouts/values.xml", /syntax: 'python'/],
    ["VC0407", "errpack/layouts/values.xml", /size: read as vec2 100 for all components/],
    ["VC0407", "errpack/layouts/values.xml", /padding: more than 4 numbers: the engine ignores '5'/],
    ["VC0407", "errpack/layouts/values.xml", /'G' isn't a hex digit/],
    ["VC0407", "errpack/layouts/values.xml", /visible: 'yes' counts as false/],
    ["VC0407", "errpack/layouts/values.xml", /interactive: without a value this is false/],
    ["VC0407", "errpack/layouts/values.xml", /z-index: read as 1/],
    ["VC0408", "errpack/layouts/values.xml", /id 'a' is already used on line 2/],
    ["VC0408", "errpack/layouts/values.xml", /id 'dup'.*aren't indexed either \('lost'\)/],
    ["VC0408", "errpack/layouts/values.xml", /'root' is the layout's root element/],
    ["VC0409", "errpack/layouts/values.xml", /use document\.root, not document\.screen/],
    ["VC0410", "errpack/layouts/callbacks.xml", /onclick is run as Lua statements, and 'refresh' alone isn't one.*refresh\(\)/],
    ["VC0410", "errpack/layouts/callbacks.xml", /supplier is evaluated as 'return 'count: ' \.\.'/],
    ["VC0411", "errpack/layouts/callbacks.xml", /'save_setting' isn't defined in callbacks\.xml\.lua/],
    ["VC0412", "errpack/layouts/names.xml", /texture 'gui\/nope' not found.*plain rectangle/],
    ["VC0412", "errpack/layouts/names.xml", /texture 'blocks:nope' not found/],
    ["VC0412", "errpack/layouts/names.xml", /no 'atlasx' atlas/],
    ["VC0412", "errpack/layouts/names.xml", /model 'no_such_model' not found/],
    ["VC0412", "errpack/layouts/names.xml", /layout 'errpack:no_layout' not found/],
    ["VC0412", "errpack/layouts/names.xml", /a layout id is 'pack:name'/],
    ["VC0413", "errpack/layouts/names.xml", /'gui\/unloaded' isn't in the textures of any preload\.json/],
    ["VC0415", "errpack/layouts/names.xml", /no <option> has the value 'tow'.*did you mean 'two'/],
    ["VC0416", "errpack/layouts/names.xml", /font 'bold' isn't loaded \(preload\.json fonts: normal\)/],
    ["VC0414", "errpack/layouts/names.xml", /binding 'movement\.forwad' does not exist.*did you mean 'movement\.forward'/],
];

for (const [code, file, pattern] of EXPECTED) {
    test(`${code} fires: ${file}${pattern ? " " + pattern : ""}`, () => has(code, file, pattern));
}

// projects: errproject (goodpack is a base pack outside its content sources)
const proj = lintProjectDir(path.join(FIXTURES, "errproject"), [GOODPACK]);
const PROJECT_EXPECTED: [string, string, RegExp][] = [
    ["VC0500", "errproject/project.toml", /unknown permission 'netwrk'.*Did you mean 'network'/],
    ["VC0501", "errproject/project.toml", /base pack 'nosuchbase' not found in errproject\/content or res\/content/],
    ["VC0502", "errproject/project.toml", /base pack 'goodpack' is outside this project's content sources/],
    ["VC0503", "errproject/start.lua", /'network\.get' needs the project permission 'network'/],
    ["VC0503", "errproject/start.lua", /'file\.write' needs the project permission 'write-to-user'/],
    ["VC0503", "errproject/start.lua", /'app\.start_debug_instance' needs the project permission 'debugging'/],
    ["VC0503", "errproject/content/projpack/scripts/world.lua", /'app\.start_background_instance' needs .*'sub-instances'/],
    ["VC0504", "errproject/project_client.lua", /require 'helper' fails in project_client\.lua.*use 'project:helper'/],
    ["VC0103", "errproject/start.lua", /module 'no_such_module' not found \(errproject\/modules\/no_such_module\.lua\)/],
    ["VC0101", "errproject/project_client.lua", /'on_menu_stup'.*project client script.*Did you mean 'on_menu_setup'/],
];

for (const [code, file, pattern] of PROJECT_EXPECTED) {
    test(`${code} fires: ${file} ${pattern}`, () => {
        assert.ok(proj.diagnostics.some((d) => d.code === code && rel(d.file) === file && pattern.test(d.message)),
            `expected ${code} in ${file} matching ${pattern}\n` + proj.diagnostics.filter((d) => rel(d.file) === file).map(describe).join("\n"));
    });
}

test("projects: no false positives in errproject", () => {
    const codes = (file: string) => proj.diagnostics.filter((d) => rel(d.file) === file).map((d) => `${d.code} ${d.message}`);
    // resolved requires, network.is_available, world: writes, granted record-audio, base packs found
    assert.equal(codes("errproject/start.lua").length, 4, codes("errproject/start.lua").join("\n"));
    assert.equal(codes("errproject/project_client.lua").length, 2, codes("errproject/project_client.lua").join("\n"));
    assert.equal(codes("errproject/project.toml").length, 3, codes("errproject/project.toml").join("\n"));
});

test("res/project (the engine's default project) is clean", () => {
    const res = lintProjectDir(path.join(RES, "project"));
    assert.equal(res.index.projects.find((p) => p.root === path.join(RES, "project"))?.builtin, true);
    assert.deepEqual(res.diagnostics.map(describe), []);
});

test("project index: fields, scripts, content packs", () => {
    const project = proj.index.projects.find((p) => p.name === "errproject")!;
    assert.deepEqual(project.basePacks, ["base", "projpack", "nosuchbase", "goodpack"]);
    assert.deepEqual(project.permissions, ["record-audio", "netwrk"]);
    assert.ok(project.startScript && project.clientScript);
    assert.equal(proj.index.projectOfPack(proj.index.packs.get("projpack")!), project);
    assert.equal(proj.index.projectOfPack(proj.index.packs.get("goodpack")!), undefined);
    assert.equal(proj.index.projectFile(path.join(project.root, "start.lua"))?.kind, "start");
    assert.equal(proj.index.projectFile(path.join(project.root, "modules", "helper.lua")), undefined);
});

test("grant permission edit", () => {
    const apply = (text: string, perm: string) => {
        const [s, e, t] = grantPermissionEdit(text, perm);
        return text.slice(0, s) + t + text.slice(e);
    };
    assert.equal(apply('name = "x"\npermissions = []\n', "network"), 'name = "x"\npermissions = ["network"]\n');
    assert.equal(apply('permissions = ["a", ]\n', "network"), 'permissions = ["a", "network"]\n');
    assert.equal(apply('permissions = [\n    "a",\n]\n', "network"), 'permissions = [\n    "a",\n    "network"\n]\n');
    assert.equal(apply('name = "x"', "network"), 'name = "x"\npermissions = ["network"]\n');
    assert.equal(apply('name = "x"\n[extra]\nk = 1\n', "debugging"), 'name = "x"\npermissions = ["debugging"]\n[extra]\nk = 1\n');
});

test("every rule has a positive fixture", () => {
    const covered = new Set([...EXPECTED, ...PROJECT_EXPECTED].map(([code]) => code));
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

test("the engine's own layouts (res/layouts) lint clean apart from real findings", () => {
    const index = new ContentIndex({ resPath: RES, packDirs: [] });
    const env = createEnv(index, {}, false);
    const found: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith(".xml")) {
                for (const d of lintDocument(env, p, fs.readFileSync(p, "utf8"))) found.push(`${path.relative(RES, p).replaceAll("\\", "/")} ${d.code} ${d.message}`);
            }
        }
    };
    walk(path.join(RES, "layouts"));
    // all real (ENGINE_NOTES.md): interval on a <container>, which doesn't read it;
    // three elements with id "move_left"; code_editor's root id is replaced by "root"
    assert.deepEqual(found, [
        "layouts/code_editor.xml VC0409 the engine renames the root element to 'root': use document.root, not document.editorRoot",
        "layouts/pages/content.xml VC0402 <container> doesn't read 'interval'; the engine ignores it silently (only <panel>, <slots-grid> read it)",
        "layouts/pages/content.xml VC0408 id 'move_left' is already used on line 6: document.move_left is that element",
        "layouts/pages/content.xml VC0408 id 'move_left' is already used on line 6: document.move_left is that element",
        "layouts/pages/content_menu.xml VC0402 <container> doesn't read 'interval'; the engine ignores it silently (only <panel>, <slots-grid> read it)",
        "layouts/templates/binding.xml VC0412 src: texture 'gui/left_half_block' not found (textures/gui/left_half_block.png in no pack): the image is drawn as a plain rectangle of its color (Batch2D blank texture)",
    ]);
});
