import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ContentIndex } from "../../shared/content/index";
import { codeActions } from "../../server/src/features/codeActions";
import { complete, definition, documentSymbols, hover } from "../../server/src/features/language";
import { vcmCompletions } from "../../server/src/features/vcm";
import { createEnv } from "../../server/src/linter";
import { scriptRole } from "../../server/src/lua/analyze";
import { ERRPACK, FIXTURES, GOODPACK, RES } from "./helpers";

const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK, ERRPACK] });
const env = createEnv(index, {}, true);

function at(file: string, text: string, marker = "|") {
    const offset = text.indexOf(marker);
    const clean = text.slice(0, offset) + text.slice(offset + marker.length);
    return { doc: TextDocument.create("file:///x", "json", 1, clean), offset, file };
}

test("script kinds", () => {
    const pack = index.packs.get("goodpack")!;
    const kind = (rel: string) => scriptRole(index, pack, path.join(GOODPACK, rel)).kind;
    assert.equal(kind("scripts/world.lua"), "world");
    assert.equal(kind("scripts/crate.lua"), "block");
    assert.equal(kind("scripts/wand.lua"), "item");
    assert.equal(kind("scripts/components/golem_ai.lua"), "component");
    assert.equal(kind("layouts/crate.xml.lua"), "layout");
    assert.equal(kind("generators/plains.files/script.lua"), "generator");
    assert.equal(kind("modules/util.lua"), "module");
});

test("JSON completion: block textures, materials, items", () => {
    const file = path.join(GOODPACK, "blocks", "new.json");
    let c = at(file, '{"texture": "|"}');
    let items = complete(env, c.doc, file, c.offset).map((i) => i.label);
    assert.ok(items.includes("crate") && items.includes("stone"));
    c = at(file, '{"material": "|"}');
    assert.ok(complete(env, c.doc, file, c.offset).some((i) => i.label === "goodpack:wood"));
    c = at(file, '{"picking-item": "|"}');
    assert.ok(complete(env, c.doc, file, c.offset).some((i) => i.label === "base:stone.item"));
    c = at(file, '{"state-based": {"variants": [{"texture-faces": ["|"]}]}}');
    assert.ok(complete(env, c.doc, file, c.offset).some((i) => i.label === "crate"));
    const item = path.join(GOODPACK, "items", "x.json");
    c = at(item, '{"icon-type": "block", "icon": "|"}');
    items = complete(env, c.doc, item, c.offset).map((i) => i.label);
    assert.ok(items.includes("base:stone") && !items.includes("items:wand"));
    c = at(item, '{"icon": "|"}');
    assert.ok(complete(env, c.doc, item, c.offset).some((i) => i.label === "items:wand"));
    const ent = path.join(GOODPACK, "entities", "x.json");
    c = at(ent, '{"components": [{"name": "|"}]}');
    assert.ok(complete(env, c.doc, ent, c.offset).some((i) => i.label === "core:mob"));
});

test("Lua completion: callbacks per kind and string ids", () => {
    const file = path.join(GOODPACK, "scripts", "crate.lua");
    let c = at(file, "function on_placed() end\non_|");
    let labels = complete(env, c.doc, file, c.offset).map((i) => i.label);
    assert.ok(labels.includes("on_broken") && !labels.includes("on_placed") && !labels.includes("on_use"));
    c = at(file, 'local id = block.index("|")');
    assert.ok(complete(env, c.doc, file, c.offset).some((i) => i.label === "goodpack:crate"));
    c = at(file, 'local m = require "|"');
    labels = complete(env, c.doc, file, c.offset).map((i) => i.label);
    assert.ok(labels.includes("util") && labels.includes("base:util"));
    const comp = path.join(GOODPACK, "scripts", "components", "golem_ai.lua");
    c = at(comp, "on_|");
    assert.ok(complete(env, c.doc, comp, c.offset).some((i) => i.label === "on_sensor_enter"));
});

test("VCM/VCA completion contexts", () => {
    const labels = (lang: "vcm" | "vca", text: string) => {
        const offset = text.indexOf("|");
        return vcmCompletions(lang, text.replace("|", ""), offset).items.map((i) => i.label);
    };
    assert.deepEqual(labels("vcm", "@|").sort(), ["bone", "box", "rect", "tri"]);
    assert.deepEqual(labels("vcm", "@box from 0 to 1 {\n  @|\n}"), ["part"]);
    assert.ok(labels("vcm", "@box from (0,0,0) |").includes("to"));
    assert.ok(!labels("vcm", "@box from (0,0,0) |").includes("from"));
    assert.deepEqual(labels("vcm", "@rect cull-face |"), ["back", "front", "off"]);
    assert.ok(labels("vca", "@|").includes("configure"));
    assert.ok(labels("vca", "@curve name s func (t)\n@move by x curve |").includes(".s"));
});

test("hover and definition", () => {
    const file = path.join(GOODPACK, "blocks", "crate.json");
    const text = fs.readFileSync(file, "utf8");
    const doc = TextDocument.create("file:///crate.json", "json", 1, text);
    const offset = text.indexOf('"crate"') + 2;
    const h = hover(env, doc, file, offset);
    assert.match(JSON.stringify(h?.contents), /goodpack:textures\/blocks\/crate\.png/);
    const def = definition(env, doc, file, offset);
    assert.equal(def.length, 1);
    assert.match(def[0].uri, /crate\.png$/);
    const vcm = path.join(GOODPACK, "models", "statue.vcm");
    const vtext = fs.readFileSync(vcm, "utf8");
    const vdoc = TextDocument.create("file:///statue.vcm", "vcm", 1, vtext);
    assert.match(JSON.stringify(hover(env, vdoc, vcm, vtext.indexOf("@box") + 2)?.contents), /parallelepiped/);
    assert.match(definition(env, vdoc, vcm, vtext.indexOf("blocks:crate") + 3)[0].uri, /crate\.png$/);
    const lua = path.join(GOODPACK, "scripts", "world.lua");
    const ltext = fs.readFileSync(lua, "utf8");
    const ldoc = TextDocument.create("file:///world.lua", "lua", 1, ltext);
    assert.match(definition(env, ldoc, lua, ltext.indexOf('"base:util"') + 2)[0].uri, /base\/modules\/util\.lua$/);
});

test("document symbols outline bones and primitives", () => {
    const vcm = path.join(GOODPACK, "models", "statue.vcm");
    const doc = TextDocument.create("file:///statue.vcm", "vcm", 1, fs.readFileSync(vcm, "utf8"));
    const symbols = documentSymbols(doc, vcm);
    assert.deepEqual(symbols.map((s) => s.name), ["@box", "@bone arm", "@bone"]);
    assert.deepEqual(symbols[1].children!.map((s) => s.name), ["@rect", "@tri"]);
});

test("quick fixes", () => {
    const file = path.join(ERRPACK, "blocks", "bad.json");
    const text = fs.readFileSync(file, "utf8");
    const doc = TextDocument.create("file:///bad.json", "json", 1, text);
    const keyStart = doc.positionAt(text.indexOf('"texure"'));
    const keyEnd = doc.positionAt(text.indexOf('"texure"') + 8);
    const jsonDiag = { range: { start: keyStart, end: keyEnd }, message: "Property texure is not allowed.", source: "json" };
    const rename = codeActions(env, doc, file, [jsonDiag]);
    assert.equal(rename[0].title, "Rename to 'texture'");
    assert.equal(rename[0].edit!.changes!["file:///bad.json"][0].newText, '"texture"');
    const prop = codeActions(env, doc, file, [{
        range: jsonDiag.range, message: "", source: "voxelcore", code: "VC0011",
        data: { prop: "errpack_x:undeclared", declarePack: "errpack_x" },
    }]);
    assert.match(prop[0].title, /user-props\.toml/);
    assert.ok(prop[0].edit!.documentChanges, "creates config/user-props.toml");
    const tex = codeActions(env, doc, file, [{
        range: jsonDiag.range, message: "", source: "voxelcore", code: "VC0020",
        data: { createTexture: { atlas: "blocks", name: "nope" } },
    }]);
    assert.equal(tex[0].command!.command, "voxelcore.server.createTexture");
});

test("project scripts: kinds, callback completion, module definition", () => {
    const root = path.join(FIXTURES, "errproject");
    const pindex = new ContentIndex({ resPath: RES, roots: [root] });
    const penv = createEnv(pindex, {}, true);
    assert.equal(scriptRole(pindex, undefined, path.join(root, "start.lua")).kind, "app");
    assert.equal(scriptRole(pindex, undefined, path.join(root, "project_client.lua")).kind, "project");
    const client = path.join(root, "project_client.lua");
    const c = at(client, "function on_menu_setup() end\n|");
    const labels = complete(penv, c.doc, client, c.offset).map((i) => i.label);
    assert.deepEqual(labels.sort(), ["on_level_clear", "on_level_setup", "on_menu_clear"]);
    const start = path.join(root, "start.lua");
    for (const spec of ["helper", "project:helper"]) {
        const d = at(start, `local h = require "${spec.replace("helper", "hel|per")}"`);
        const targets = definition(penv, d.doc, start, d.offset).map((l) => l.uri);
        assert.equal(targets.length, 1, spec);
        assert.ok(targets[0].endsWith("/errproject/modules/helper.lua"), targets[0]);
    }
});
