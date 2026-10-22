import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { layoutContextAt, parseLayoutXml, type XmlNode } from "../../shared/layouts/xml";

const ROOT = path.join(__dirname, "..", "..", "..");

/** The shape the engine's `xml.parse` gives (scratch probe through a headless engine). */
function dump(node: XmlNode | undefined): string {
    if (!node) return "nil";
    if (node.type === "text") return `'${node.value}'`;
    const attrs = new Map<string, string>();
    for (const a of node.attributes) attrs.set(a.name, a.value); // last one wins, like Node::set
    const list = [...attrs].map(([k, v]) => `${k}=${v}`).sort();
    const sub = node.children.map(dump);
    return `${node.tag}{${list.join(",")}}` + (sub.length ? `[${sub.join(" ")}]` : "");
}

function firstError(source: string): string | undefined {
    const doc = parseLayoutXml(source);
    const e = doc.errors[0];
    if (!e) return undefined;
    // the engine's column: offset from the line start
    const col = e.pos - (source.lastIndexOf("\n", e.pos - 1) + 1);
    return `${col}: ${e.message}`;
}

describe("layout XML parser (engine xml::parse port)", () => {
    // results of the engine's xml.parse for each snippet
    const ok: [string, string, string][] = [
        ["declaration + newline", '<?xml version="1.0"?>\n<panel/>', "panel{}"],
        ["leading comment", "<!-- c -->\n<panel/>", "panel{}"],
        ["space after '<' at the start (goBack quirk)", "< panel ></panel >", "'panel >'"],
        ["escapes and entities in text", "<label>a\\nb &amp; c</label>", "label{}['a\nb & c']"],
        ["attribute without a value", "<panel visible/>", "panel{visible=}"],
        ["repeated attribute: last wins", '<panel id="a" id="b"/>', "panel{id=b}"],
        ["content after the root is ignored", "<panel/>\n<label/>junk", "panel{}"],
        ["a raw & in text", "<label>a & b</label>", "label{}['a & b']"],
        ["< and > inside a quoted value", '<panel onclick="if a < b then end"/>', "panel{onclick=if a < b then end}"],
        ["text and elements mixed", "<panel>hi<label/>there</panel>", "panel{}['hi' label{} 'there']"],
        ["comments between children", "<panel><!-- x --><label/></panel>", "panel{}[label{}]"],
    ];
    for (const [name, source, expected] of ok) {
        test(name, () => {
            const doc = parseLayoutXml(source);
            assert.deepEqual(doc.errors, []);
            assert.equal(dump(doc.root), expected);
        });
    }

    // engine messages and columns ("parsing error ... at <line>:<col>: <message>")
    const errors: [string, string, string][] = [
        ["newline in a quoted value", '<panel onclick="a()\nb()"/>', "19: non-closed string literal"],
        ["illegal escape in a value", '<label tooltip="C:\\q"/>', "20: '\\q' is an illegal escape"],
        ["illegal escape in text", "<label>a\\qb</label>", "10: '\\q' is an illegal escape"],
        ["CDATA", "<label><![CDATA[x]]></label>", '8: "!--" expected'],
        ["mismatched close tag", "<panel></label>", '9: "panel" expected'],
        ["unclosed elements", "<panel><label>", "14: unexpected end"],
        ["unquoted value", "<panel id=a/>", "10: string literal expected"],
        ["broken comment", "<panel><!- x -></panel>", '8: "!--" expected'],
        ["empty file", "", "0: unexpected end"],
    ];
    for (const [name, source, expected] of errors) {
        test(`error: ${name}`, () => assert.equal(firstError(source), expected));
    }

    test("the text error column is in the file, not the text", () => {
        // the engine reports it relative to the text ("2:3"); we highlight the escape
        const doc = parseLayoutXml("<label>a\\qb</label>");
        assert.equal(doc.errors[0].pos, "<label>a\\q".length);
        assert.deepEqual(doc.errors[0].span, { start: "<label>a".length, end: "<label>a\\q".length });
    });

    test("spans: tags, attributes, values, close tags", () => {
        const src = `<panel id='p' color="#FF0000">\n  <label>@key</label>\n</panel>`;
        const doc = parseLayoutXml(src);
        const root = doc.root;
        assert.ok(root?.type === "element");
        assert.equal(src.slice(root.tagSpan.start, root.tagSpan.end), "panel");
        const color = root.attributes[1];
        assert.equal(src.slice(color.nameSpan.start, color.nameSpan.end), "color");
        assert.equal(src.slice(color.valueSpan!.start, color.valueSpan!.end), "#FF0000");
        assert.equal(color.quote, '"');
        assert.equal(src.slice(root.closeTagSpan!.start, root.closeTagSpan!.end), "</panel>");
        assert.equal(root.span.end, src.length);
        const label = root.children[0];
        assert.ok(label.type === "element");
        assert.equal(label.children[0].type === "text" && label.children[0].value, "@key");
    });

    test("recovers after an error so editors keep a tree", () => {
        const doc = parseLayoutXml(`<panel>\n  <button id="a\n  <label id="b"/>\n</panel>`);
        assert.equal(doc.errors[0].message, "non-closed string literal");
        assert.ok(doc.root?.type === "element" && doc.root.tag === "panel");
        const tags = doc.root.children.filter((c) => c.type === "element").map((c) => c.type === "element" && c.tag);
        assert.ok(tags.includes("label"), JSON.stringify(tags));
    });

    test("an unclosed child doesn't swallow its parent's close tag", () => {
        const doc = parseLayoutXml("<panel><container><label/></panel>");
        assert.equal(doc.errors[0].message, '"container" expected');
        assert.ok(doc.root?.type === "element");
        assert.ok(doc.root.closeTagSpan);
    });

    test("every layout of the engine and the packs parses without errors", () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            if (!fs.existsSync(dir)) return;
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (p.endsWith(".xml") && p.includes(`${path.sep}layouts${path.sep}`)) files.push(p);
            }
        };
        walk(path.join(ROOT, "res"));
        walk(path.join(ROOT, "packs"));
        assert.ok(files.length > 20, `only ${files.length} layouts found`);
        for (const file of files) {
            const doc = parseLayoutXml(fs.readFileSync(file, "utf8"));
            assert.deepEqual(doc.errors, [], file);
            assert.equal(doc.root?.type, "element", file);
        }
    });
});

describe("layout editing context", () => {
    const at = (marked: string) => {
        const offset = marked.indexOf("|");
        return layoutContextAt(marked.replace("|", ""), offset);
    };

    test("tag names, with the enclosing element", () => {
        assert.deepEqual(at("<panel>\n  <bu|"), { kind: "tag", parent: "panel", start: 11 });
        assert.deepEqual(at("<|"), { kind: "tag", parent: undefined, start: 1 });
        assert.deepEqual(at("<panel><label/><|"), { kind: "tag", parent: "panel", start: 16 });
        assert.deepEqual(at("<panel><select></select><|"), { kind: "tag", parent: "panel", start: 25 });
        assert.deepEqual(at("<panel><select>\n<op|"), { kind: "tag", parent: "select", start: 17 });
    });

    test("close tags", () => {
        assert.deepEqual(at("<panel><label></|"), { kind: "closeTag", open: "label", start: 16 });
    });

    test("attribute names, with the ones already there", () => {
        assert.deepEqual(at('<panel id="x" |'), { kind: "attribute", tag: "panel", start: 14, present: ["id"] });
        assert.deepEqual(at('<panel id="x" ori|'), { kind: "attribute", tag: "panel", start: 14, present: ["id"] });
        assert.deepEqual(at("<label visible |/>"), { kind: "attribute", tag: "label", start: 15, present: ["visible"] });
    });

    test("attribute values", () => {
        assert.deepEqual(at('<panel orientation="ho|'), { kind: "value", tag: "panel", attribute: "orientation", start: 20, quote: '"' });
        assert.deepEqual(at("<panel gravity='|'/>"), { kind: "value", tag: "panel", attribute: "gravity", start: 16, quote: "'" });
        assert.deepEqual(at('<panel a="x>y" b="|'), { kind: "value", tag: "panel", attribute: "b", start: 18, quote: '"' });
    });

    test("text and comments are not completed", () => {
        assert.deepEqual(at("<label>hel|"), { kind: "none" });
        assert.deepEqual(at("<panel><!-- <la|"), { kind: "none" });
    });
});
