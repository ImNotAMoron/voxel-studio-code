import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ContentIndex } from "../../shared/content/index";
import { idToCaption, parseLocale, translations } from "../../shared/content/locale";
import { codeActions } from "../../server/src/features/codeActions";
import { documentSymbols, hover } from "../../server/src/features/language";
import { createEnv, lintDocument } from "../../server/src/linter";
import type { VcDiagnostic } from "../../server/src/rules/report";
import { BACKROOMS, BASE, ERRPACK, GOODPACK, RES } from "./helpers";

test("locale parser follows the engine reader", () => {
    const parsed = parseLocale("# Menu\n  key one = Value \\n two\r\nescaped\\u0041=x\\\ny\n# end\nempty=\nk=a=b\n");
    assert.deepEqual(parsed.entries.map((e) => [e.key, e.value]), [
        ["key one", "Value \n two"],
        ["escapedA", "xy"], // \uXXXX in keys, backslash-newline continues the line
        ["empty", ""],
        ["k", "a=b"], // only the first '=' separates
    ]);
    assert.deepEqual(parsed.comments.map((c) => [c.text, c.line]), [["# Menu", 0], ["# end", 4]]);
    assert.equal(parsed.error, undefined);
    const e = parsed.entries[0];
    assert.equal("# Menu\n  key one = Value \\n two".slice(e.keyStart, e.keyEnd), "key one");
    assert.match(parseLocale("a=1\nno equals here\nb=2\n").error!.message, /non-closed/);
    assert.match(parseLocale("a=bad \\q escape\n").error!.message, /'\\q' is an illegal escape/);
    assert.match(parseLocale("last line").error!.message, /unexpected end/);
    assert.equal(idToCaption("base:grass_block"), "grass block");
});

test("the engine's own texts and the real packs parse cleanly", () => {
    for (const dir of [path.join(RES, "texts"), path.join(BASE, "texts"), path.join(BACKROOMS, "texts")]) {
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".txt"))) {
            assert.equal(parseLocale(fs.readFileSync(path.join(dir, f), "utf8")).error, undefined, f);
        }
    }
});

const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK, ERRPACK] });
const env = createEnv(index, {}, true);

test("translations come from res/texts and every pack, last loaded wins", () => {
    const grass = translations(index, "grass block");
    assert.ok(grass.some((t) => t.lang === "ru_RU" && t.pack === "base" && t.value === "дёрн"));
    const menu = translations(index, "Cancel");
    assert.ok(menu.some((t) => t.pack === "core"), "core texts are read from res/texts");
});

const toLsp = (doc: TextDocument, d: VcDiagnostic) => ({
    range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) },
    message: d.message, source: "voxelcore", code: d.code, data: d.data,
});

test("stub quick fix for missing translations", () => {
    const file = path.join(ERRPACK, "texts", "ru_RU.txt");
    const text = fs.readFileSync(file, "utf8");
    const doc = TextDocument.create("file:///ru", "vclang", 1, text);
    const diags = lintDocument(env, file, text).filter((d) => d.code === "VC0303" || d.code === "VC0304");
    assert.equal(diags.length, 2);
    const actions = codeActions(env, doc, file, diags.map((d) => toLsp(doc, d)));
    assert.deepEqual(actions.map((a) => a.title), ["Add 1 missing key to translate", `Add ${(diags[1].data as any).stubs.length} missing keys to translate`]);
    const inserted = Object.values(actions[0].edit!.changes!)[0][0].newText;
    assert.match(inserted, /# TODO: translate .*\nonly_de=only_de\n$/);
    // the stubs parse back
    assert.equal(parseLocale(text + inserted).error, undefined);
});

test("locale outline and key hover", () => {
    const file = path.join(BASE, "texts", "ru_RU.txt");
    const text = "# Blocks\ngrass block=дёрн\nsand=песок\n# Items\nbazalt breaker=крушитель\n";
    const doc = TextDocument.create("file:///ru", "vclang", 1, text);
    const symbols = documentSymbols(doc, file);
    assert.deepEqual(symbols.map((s) => [s.name, s.children?.map((c) => c.name)]), [["Blocks", ["grass block", "sand"]], ["Items", ["bazalt breaker"]]]);
    const h = hover(env, doc, file, text.indexOf("grass") + 2)!;
    const md = (h.contents as { value: string }).value;
    assert.match(md, /\| ru_RU \| дёрн \| base \|/);
    assert.match(md, /\| uk_UA \|/);
});
