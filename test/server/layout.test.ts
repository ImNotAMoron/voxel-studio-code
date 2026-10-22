import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CompletionItem, Hover, MarkupContent } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ContentIndex } from "../../shared/content/index";
import { codeActions } from "../../server/src/features/codeActions";
import { complete, definition, documentSymbols, hover } from "../../server/src/features/language";
import { layoutColorPresentations, layoutColors, parseLayoutColor } from "../../server/src/features/layout";
import { ReferenceIndex, layoutRefs } from "../../server/src/features/references";
import { findReferences, prepareRename, rename } from "../../server/src/features/navigation";
import { documentIds } from "../../shared/layouts/ids";
import { parseLayoutXml } from "../../shared/layouts/xml";
import { createEnv, fileRole, lintDocument } from "../../server/src/linter";
import type { VcDiagnostic } from "../../server/src/rules/report";
import { ERRPACK, GOODPACK, RES } from "./helpers";

const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK, ERRPACK] });
const env = createEnv(index, {}, true);
const FILE = path.join(GOODPACK, "layouts", "test.xml");

/** `|` marks the cursor. */
function at(marked: string): { doc: TextDocument; offset: number } {
    const offset = marked.indexOf("|");
    return { doc: TextDocument.create("file:///test.xml", "xml", 1, marked.replace("|", "")), offset };
}
const labels = (items: CompletionItem[]) => items.map((i) => i.label);
const hoverText = (h: Hover | null) => (h?.contents as MarkupContent | undefined)?.value ?? "";

test("layouts get the layout role: top level, pages, templates, and the engine's res/layouts", () => {
    assert.equal(fileRole(index, FILE).role, "layout");
    assert.equal(fileRole(index, path.join(GOODPACK, "layouts", "templates", "entry.xml")).role, "layout");
    assert.equal(fileRole(index, path.join(RES, "layouts", "pages", "main.xml")).role, "layout");
    assert.equal(fileRole(index, path.join(GOODPACK, "models", "x.xml")).role, "other");
});

test("tag completion offers what the parent reads", () => {
    const { doc, offset } = at("<panel>\n    <|");
    const items = complete(env, doc, FILE, offset);
    assert.ok(labels(items).includes("button"));
    assert.ok(!labels(items).includes("option"), "option only inside select");
    const button = items.find((i) => i.label === "button")!;
    assert.equal((button.textEdit as { newText: string }).newText, "button$1>$0</button>");
    const image = items.find((i) => i.label === "image")!;
    assert.equal((image.textEdit as { newText: string }).newText, "image$1/>");

    const select = at("<select>\n<|");
    assert.equal(complete(env, select.doc, FILE, select.offset)[0].label, "option");
    const inventory = at("<inventory><|");
    assert.deepEqual(labels(complete(env, inventory.doc, FILE, inventory.offset)).slice(0, 2).sort(), ["slot", "slots-grid"]);
    const leaf = at("<label><|");
    assert.deepEqual(complete(env, leaf.doc, FILE, leaf.offset), []);
});

test("close tag completion", () => {
    const { doc, offset } = at("<panel><label></|");
    const [item] = complete(env, doc, FILE, offset);
    assert.equal(item.label, "label");
    assert.equal((item.textEdit as { newText: string }).newText, "label>");
});

test("attribute completion: the element's own first, typed snippets, present ones left out", () => {
    const { doc, offset } = at('<panel id="x" |');
    const items = complete(env, doc, FILE, offset);
    const names = labels(items);
    assert.ok(!names.includes("id"));
    assert.ok(names.includes("orientation") && names.includes("interval") && names.includes("onclick"));
    const sorted = [...items].sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    assert.equal(sorted[0].label, "interval", "read_panel's own attribute first");
    const orientation = items.find((i) => i.label === "orientation")!;
    assert.equal((orientation.textEdit as { newText: string }).newText, 'orientation="${1|horizontal,vertical|}"');
    const visible = items.find((i) => i.label === "visible")!;
    assert.equal((visible.textEdit as { newText: string }).newText, 'visible="${1|true,false|}"');
    // no attributes for unknown elements
    const unknown = at("<blah |");
    assert.deepEqual(complete(env, unknown.doc, FILE, unknown.offset), []);
    // renaming an existing attribute name keeps its value
    const rename = at('<panel orien|tation="horizontal"');
    const item = complete(env, rename.doc, FILE, rename.offset).find((i) => i.label === "orientation")!;
    assert.equal((item.textEdit as { newText: string }).newText, "orientation");
});

test("value completion: enums and booleans", () => {
    const gravity = at('<label gravity="|');
    assert.ok(labels(complete(env, gravity.doc, FILE, gravity.offset)).includes("bottom-right"));
    const mode = at('<select mode="|"');
    const items = complete(env, mode.doc, FILE, mode.offset);
    assert.deepEqual(labels(items), ["button", "select"]);
    assert.match((items[0].documentation as MarkupContent).value, /button mode/);
    const bool = at("<checkbox checked='|'");
    assert.deepEqual(labels(complete(env, bool.doc, FILE, bool.offset)), ["true", "false"]);
    const free = at('<label id="|"');
    assert.deepEqual(complete(env, free.doc, FILE, free.offset), []);
});

test("hover: elements, attributes and enum values", () => {
    const text = '<panel orientation="horizontal" onclick="go()">\n  <trackbar consumer="function(v) end" track-width="3"/>\n</panel>';
    const doc = TextDocument.create("file:///test.xml", "xml", 1, text);
    const h = (needle: string, delta = 1) => hoverText(hover(env, doc, FILE, text.indexOf(needle) + delta));
    assert.match(h("panel"), /\*\*<panel>\*\*.*read_panel/);
    assert.match(h("panel"), /Reads: child elements/);
    assert.match(h("</panel") /* close tag */, /^$/);
    assert.match(h("</panel", 3), /\*\*<panel>\*\*/);
    assert.match(h("orientation"), /one of `horizontal` \| `vertical`/);
    assert.match(h("onclick"), /Lua code \(statements\)/);
    assert.match(h("consumer"), /Lua expression.*`function\(number\)`/);
    assert.match(h("track-width"), /integer · default `12`/);
    assert.match(h("track-width"), /every element|this element/);
    assert.match(h("go()"), /onclick/);
});

test("hover marks undocumented attributes and elements", () => {
    const text = '<modelviewer src="x" cam-rotation="0,0,0"/>';
    const doc = TextDocument.create("file:///test.xml", "xml", 1, text);
    assert.match(hoverText(hover(env, doc, FILE, 2)), /Not in the docs yet/);
    assert.match(hoverText(hover(env, doc, FILE, text.indexOf("cam-rotation") + 1)), /3D vector[\s\S]*Not in the docs/);
});

test("outline: the element tree with ids and text", () => {
    const text = '<container id="menu">\n  <panel>\n    <label>Hello</label>\n  </panel>\n</container>';
    const doc = TextDocument.create("file:///test.xml", "xml", 1, text);
    const [root] = documentSymbols(doc, FILE);
    assert.equal(root.name, "<container> #menu");
    assert.equal(root.children![0].name, "<panel>");
    assert.equal(root.children![0].children![0].detail, "Hello");
});

test("quick fix renames a misspelled element with its close tag, and an attribute", () => {
    const text = '<panel orientaton="horizontal">\n  <buton>Hi</buton>\n</panel>';
    const doc = TextDocument.create("file:///test.xml", "xml", 1, text);
    const diags = lintDocument(env, FILE, text).filter((d) => d.code === "VC0401" || d.code === "VC0402");
    const toLsp = (d: VcDiagnostic) => ({ range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) }, message: d.message, source: "voxelcore", code: d.code, data: d.data });
    const actions = codeActions(env, doc, FILE, diags.map(toLsp));
    assert.deepEqual(actions.map((a) => a.title).sort(), ["Rename to 'button'", "Rename to 'orientation'"]);
    const edits = Object.values(actions.find((a) => a.title === "Rename to 'button'")!.edit!.changes!)[0];
    assert.equal(TextDocument.applyEdits(doc, edits), '<panel orientaton="horizontal">\n  <button>Hi</button>\n</panel>');
});

test("quick fix replaces a misspelled enum value and a boolean", () => {
    const text = '<panel orientation="Horizontal" visible="True"/>';
    const doc = TextDocument.create("file:///test.xml", "xml", 1, text);
    const diags = lintDocument(env, FILE, text).filter((d) => d.code === "VC0406" || d.code === "VC0407");
    const toLsp = (d: VcDiagnostic) => ({ range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) }, message: d.message, source: "voxelcore", code: d.code, data: d.data });
    const actions = codeActions(env, doc, FILE, diags.map(toLsp));
    const edits = actions.flatMap((a) => Object.values(a.edit!.changes!)[0]);
    assert.equal(TextDocument.applyEdits(doc, edits), '<panel orientation="horizontal" visible="true"/>');
});

test("colour swatches: hex and r,g,b,a values of colour attributes, like Attribute::asColor", () => {
    const text = '<panel color="#FF8000" hover-color="#00000080" pressed-color="255,0,0,128">\n' +
        '  <label color="0" id="#FF0000"/>\n  <trackbar track-color="#GG0000"/>\n  <image color="#FFF"/>\n  <button color="%{c}"/>\n</panel>';
    const doc = TextDocument.create("file:///test.xml", "xml", 1, text);
    const colors = layoutColors(doc);
    const shown = colors.map((c) => doc.getText(c.range));
    // not a colour attribute (id), or not a value the engine reads cleanly
    assert.deepEqual(shown, ["#FF8000", "#00000080", "255,0,0,128", "0"]);
    assert.deepEqual(colors[0].color, { red: 1, green: 128 / 255, blue: 0, alpha: 1 });
    assert.equal(colors[1].color.alpha, 128 / 255);
    assert.deepEqual(colors[3].color, { red: 0, green: 0, blue: 0, alpha: 0 }, "one number is all four components");
    assert.equal(parseLayoutColor("255,0,0"), undefined, "three numbers throw in the engine");
});

test("colour presentations keep the value's format", () => {
    const orange = { red: 1, green: 0.5, blue: 0, alpha: 1 };
    assert.deepEqual(layoutColorPresentations("#FF0000", orange).map((p) => p.label), ["#FF8000", "255,128,0,255"]);
    assert.equal(layoutColorPresentations("#ff0000", orange)[0].label, "#ff8000");
    assert.equal(layoutColorPresentations("#FF0000FF", orange)[0].label, "#FF8000FF", "8 digits stay 8");
    assert.equal(layoutColorPresentations("#FF0000", { ...orange, alpha: 0.5 })[0].label, "#FF800080");
    assert.equal(layoutColorPresentations("0,0,0,255", orange)[0].label, "255,128,0,255");
    // round trip through the engine's reading
    for (const p of layoutColorPresentations("#000000", { red: 0.2, green: 0.4, blue: 0.6, alpha: 0.8 })) {
        const back = parseLayoutColor(p.label)!;
        assert.ok(Math.abs(back.blue - 0.6) < 0.003 && Math.abs(back.alpha - 0.8) < 0.003, p.label);
    }
});

test("go to definition: a callback's function in the layout's .xml.lua", () => {
    const file = path.join(ERRPACK, "layouts", "callbacks.xml");
    const text = fs.readFileSync(file, "utf8");
    const doc = TextDocument.create("file:///callbacks.xml", "xml", 1, text);
    const [loc] = definition(env, doc, file, text.indexOf('refresh()"') + 2);
    assert.ok(loc, "no definition");
    assert.match(loc.uri, /callbacks\.xml\.lua$/);
    assert.deepEqual(loc.range, { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } });
    // not for an undefined name, a Lua keyword, or a non-Lua attribute
    assert.deepEqual(definition(env, doc, file, text.indexOf("save_setting") + 2), []);
    assert.deepEqual(definition(env, doc, file, text.indexOf("function(v)") + 2), []);
    assert.deepEqual(definition(env, doc, file, text.indexOf('size="200') + 7), []);
});

// ---- texture / model / layout names, @key texts, document.<id> (§3.7 steps 7–10)

const IDS = path.join(GOODPACK, "layouts", "ids.xml");
const MENU = path.join(GOODPACK, "layouts", "menu.xml");
const docOf = (file: string, lang = "xml") => TextDocument.create("file:///" + path.basename(file), lang, 1, fs.readFileSync(file, "utf8"));

test("layout names are references: hover with the image, definition, references index", () => {
    const doc = docOf(MENU);
    const text = doc.getText();
    const h = hoverText(hover(env, doc, MENU, text.indexOf("gui/check_mark") + 3));
    assert.match(h, /texture `gui\/check_mark` → `.*check_mark\.png`/);
    assert.match(h, /data:image\/png;base64/);
    const [loc] = definition(env, doc, MENU, text.indexOf("gui/check_mark") + 3);
    assert.match(loc.uri, /textures\/gui\/check_mark\.png$/);
    const iframe = definition(env, doc, MENU, text.indexOf("goodpack:crate") + 3);
    assert.match(iframe[0].uri, /layouts\/crate\.xml$/);
    assert.deepEqual(layoutRefs(text).map((r) => `${r.kind}:${r.value}`), ["texturePath:gui/check_mark", "model:block", "layout:goodpack:crate"]);
});

test("value completion of texture, model and layout names", () => {
    const tex = at('<image src="gui/ch|"/>');
    const names = labels(complete(env, tex.doc, FILE, tex.offset));
    assert.ok(names.includes("gui/check_mark"), "preloaded texture");
    assert.ok(names.some((n) => String(n).startsWith("blocks:")), "atlas regions");
    assert.ok(!names.includes("blocks/stone"), "plain names only for loaded textures");
    const lay = at('<iframe src="|"/>');
    assert.ok(labels(complete(env, lay.doc, FILE, lay.offset)).includes("goodpack:crate"));
});

test("@key hover follows the context: context.key first, then key (langs::get)", () => {
    const doc = docOf(IDS);
    const text = doc.getText();
    const settings = hoverText(hover(env, doc, IDS, text.indexOf("@Settings") + 2));
    assert.match(settings, /in context `menu` → key `menu\.Settings`/);
    assert.match(settings, /Настройки/);
    // no menu.Back: falls back to Back
    const back = hoverText(hover(env, doc, IDS, text.indexOf("@Back</") + 2));
    assert.match(back, /→ key `Back`/);
    assert.match(back, /Назад/);
    const tooltip = hoverText(hover(env, doc, IDS, text.indexOf('"@Back"') + 2));
    assert.match(tooltip, /→ key `Back`/);
});

test("document.<id> in the layout script: completion, hover, definition", () => {
    const script = path.join(GOODPACK, "layouts", "ids.xml.lua");
    const comp = TextDocument.create("file:///ids.xml.lua", "lua", 1, "function on_open()\n    document.\nend\n");
    const items = complete(env, comp, script, comp.getText().indexOf("document.") + 9);
    assert.deepEqual(items.map((i) => i.label).sort(), ["back", "icon", "list", "root", "row", "title"]);
    assert.match(items.find((i) => i.label === "title")!.detail!, /<label> · line 2/);
    const bracket = TextDocument.create("file:///ids.xml.lua", "lua", 1, 'document["ro');
    assert.ok(labels(complete(env, bracket, script, 12)).includes("row"));
    const doc = docOf(script, "lua");
    const text = doc.getText();
    assert.match(hoverText(hover(env, doc, script, text.indexOf("title") + 1)), /`title` → `<label>` on line 2/);
    const [loc] = definition(env, doc, script, text.indexOf('"back"') + 2);
    assert.match(loc.uri, /ids\.xml$/);
    assert.equal(loc.range.start.line, 2);
});

test("document ids follow UINode::getIndices: root, first wins, duplicate subtrees and skipped elements vanish", () => {
    const ids = documentIds(parseLayoutXml(
        '<container id="screen"><panel id="a"><label id="inner"/></panel><panel id="a"><label id="lost"/></panel>' +
        '<label id="gone" if="false"/><label><image id="ignored"/></label><label id="root"><x/></label></container>').root);
    assert.deepEqual([...ids.keys()], ["root", "a", "inner"]);
    assert.equal(ids.get("root")!.tag, "container");
});

test("callback completion: the layout script's functions, stubs, engine names", () => {
    const file = path.join(ERRPACK, "layouts", "callbacks.xml"); // callbacks.xml.lua defines refresh()
    const run = (marked: string) => {
        const offset = marked.indexOf("|");
        const doc = TextDocument.create("file:///callbacks.xml", "xml", 1, marked.replace("|", ""));
        return complete(env, doc, file, offset);
    };
    const chunk = run('<button onclick="re|"/>');
    const refresh = chunk.find((i) => i.label === "refresh")!;
    assert.equal((refresh.textEdit as { newText: string }).newText, "refresh()", "a chunk calls it");
    assert.match(refresh.detail!, /callbacks\.xml\.lua:1/);
    assert.equal(refresh.sortText![0], "0", "script functions first");
    assert.ok(labels(chunk).includes("menu") && labels(chunk).includes("gui"), "engine names");
    assert.ok(!labels(chunk).some((l) => String(l).startsWith("function(")), "no stub in a chunk");
    const expr = run('<checkbox consumer="|"/>');
    assert.equal((expr.find((i) => i.label === "refresh")!.textEdit as { newText: string }).newText, "refresh", "an expression names it");
    const stub = expr.find((i) => String(i.label).startsWith("function("))!;
    assert.equal((stub.textEdit as { newText: string }).newText, "function(checked) $0 end");
    const slot = run('<inventory><slot updatefunc="|"/></inventory>');
    assert.ok(slot.some((i) => i.label === "function(invid, slot) … end"));
    // members aren't globals
    assert.deepEqual(run('<button onclick="menu:|"/>'), []);
    assert.deepEqual(run('<button onclick="gui.|"/>'), []);
});

// ---- §3.7 step 11: layout functions and element ids in references / rename

test("references and rename: a layout script function and the callbacks that use it", () => {
    const refsIndex = new ReferenceIndex(() => index);
    const read = (f: string) => fs.readFileSync(f, "utf8");
    const script = MENU + ".lua";
    const sdoc = docOf(script, "lua");
    const at = sdoc.getText().indexOf("share") + 1;
    const locs = findReferences(refsIndex, sdoc, script, at, true, read);
    assert.deepEqual(locs.map((l) => path.basename(l.uri)).sort(), ["menu.xml", "menu.xml.lua"]);
    // the same set from the layout side
    const ldoc = docOf(MENU);
    const fromLayout = findReferences(refsIndex, ldoc, MENU, ldoc.getText().indexOf('"share"') + 2, true, read);
    assert.equal(fromLayout.length, 2);
    // rename edits both files
    const prep = prepareRename(refsIndex, ldoc, MENU, ldoc.getText().indexOf('"share"') + 2, read);
    assert.equal((prep as { placeholder: string }).placeholder, "share");
    const edit = rename(refsIndex, sdoc, script, at, "share_items", read) as { changes: Record<string, { newText: string }[]> };
    assert.deepEqual(Object.keys(edit.changes).map((u) => path.basename(u)).sort(), ["menu.xml", "menu.xml.lua"]);
    assert.ok(Object.values(edit.changes).flat().every((e) => e.newText === "share_items"));
    assert.match(String((rename(refsIndex, sdoc, script, at, "end", read) as Error).message), /isn't a Lua name/);
    assert.match(String((rename(refsIndex, sdoc, script, at, "update", read) as Error).message), /already defines 'update'/);
});

test("references and rename: an element id and its document.<id> uses", () => {
    const refsIndex = new ReferenceIndex(() => index);
    const read = (f: string) => fs.readFileSync(f, "utf8");
    const ldoc = docOf(IDS);
    const title = ldoc.getText().indexOf('"title"') + 2;
    const locs = findReferences(refsIndex, ldoc, IDS, title, true, read);
    assert.deepEqual(locs.map((l) => path.basename(l.uri)).sort(), ["ids.xml", "ids.xml.lua"]);
    const edit = rename(refsIndex, ldoc, IDS, title, "heading", read) as { changes: Record<string, { newText: string }[]> };
    assert.equal(Object.values(edit.changes).flat().length, 2);
    // document.title needs a Lua name; document["back"] doesn't
    assert.match(String((rename(refsIndex, ldoc, IDS, title, "my-title", read) as Error).message), /isn't a Lua name/);
    const back = ldoc.getText().indexOf('"back"') + 2;
    assert.ok(!(rename(refsIndex, ldoc, IDS, back, "go-back", read) instanceof Error));
    assert.match(String((rename(refsIndex, ldoc, IDS, back, "list", read) as Error).message), /already has the id 'list'/);
    assert.match(String((rename(refsIndex, ldoc, IDS, back, "root", read) as Error).message), /root element/);
    // from the script, and not for document.root
    const sdoc = docOf(IDS + ".lua", "lua");
    assert.equal(findReferences(refsIndex, sdoc, IDS + ".lua", sdoc.getText().indexOf('"back"') + 2, true, read).length, 2);
    const rootDoc = TextDocument.create("file:///ids.xml.lua", "lua", 1, "document.root.visible = true\n");
    // document.root isn't an element id: Shift+F12 falls back to the file's own symbol (the layout)
    const rootLocs = findReferences(refsIndex, rootDoc, IDS + ".lua", 11, true, () => undefined);
    assert.ok(!rootLocs.some((l) => /ids\.xml\.lua$/.test(l.uri)), JSON.stringify(rootLocs));
});
