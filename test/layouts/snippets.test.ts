import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex } from "../../shared/content/index";
import { createEnv, lintDocument } from "../../server/src/linter";
import { GOODPACK, RES } from "../server/helpers";

const EXT = path.join(__dirname, "..", "..");
const snippets = JSON.parse(fs.readFileSync(path.join(EXT, "snippets", "xml.json"), "utf8")) as Record<string, { prefix: string; body: string | string[] }>;

/** The text a snippet inserts when every placeholder keeps its default. */
function expand(body: string | string[]): string {
    let text = Array.isArray(body) ? body.join("\n") : body;
    for (let guard = 0; guard < 20 && /\$\{/.test(text); guard++) {
        text = text.replace(/\$\{\d+\|([^,|}]*)[^}]*\|\}/g, "$1").replace(/\$\{\d+:([^${}]*)\}/g, "$1");
    }
    return text.replace(/\$\d+/g, "");
}

const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK] });
const env = createEnv(index, {}, false);
const FILE = path.join(GOODPACK, "layouts", "snippet_test.xml");

test("every XML snippet, expanded with its defaults, is a clean layout", () => {
    assert.ok(Object.keys(snippets).length >= 10);
    for (const [name, snippet] of Object.entries(snippets)) {
        assert.match(snippet.prefix, /^vc-/, name);
        const body = expand(snippet.body);
        assert.doesNotMatch(body, /\$/, `${name}: unexpanded placeholder`);
        const root = /^vc-(layout|inventory)$/.test(snippet.prefix);
        const text = root ? body : /^vc-slot/.test(snippet.prefix) ? `<inventory>${body}</inventory>` : `<container>${body}</container>`;
        const noisy = lintDocument(env, FILE, text)
            // callbacks name functions the user writes next (on_click)
            .filter((d) => d.code !== "VC0411")
            .map((d) => `${d.code} ${d.message}`);
        assert.deepEqual(noisy, [], `${name}:\n${text}`);
    }
});

test("snippet expansion handles nested placeholders and choices", () => {
    assert.equal(expand('<label${1: id="${2:title}"}>${3:@Text}</label>'), '<label id="title">@Text</label>');
    assert.equal(expand("${1|vertical,horizontal|}"), "vertical");
});
