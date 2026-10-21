import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseVcm, parseNumbers, walkVcm } from "../../shared/vcm/parser";

const engineRoot = path.resolve(__dirname, "../../..");

test("parses every engine .vcm model without errors", () => {
    const dir = path.join(engineRoot, "res/models");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".vcm"));
    assert.ok(files.length > 0);
    for (const file of files) {
        const doc = parseVcm(fs.readFileSync(path.join(dir, file), "utf8"));
        assert.deepEqual(doc.errors, [], file);
        assert.ok(doc.elements.length > 0, file);
    }
});

test("reads attributes, groups, strings, words and nesting", () => {
    const src = [
        "# comment",
        "@bone name 'body' move (0, 0.5, 0) {",
        "    @box from (0,0,0) to (1,1,1) shading off { # trailing comment",
        '        @part tags (top,bottom) texture "blocks:sand"',
        "    }",
        "}",
        "@rect from (0,0,0) right (1,0,0) up (0,1,0)",
    ].join("\n");
    const doc = parseVcm(src);
    assert.deepEqual(doc.errors, []);
    assert.equal(doc.elements.length, 2);
    const [bone, rect] = doc.elements;
    assert.equal(bone.tag, "bone");
    assert.deepEqual(
        bone.attributes.map((a) => [a.name, a.value, a.kind]),
        [
            ["name", "body", "string"],
            ["move", "0, 0.5, 0", "group"],
        ]
    );
    const box = bone.children[0];
    assert.equal(box.attributes.find((a) => a.name === "shading")?.value, "off");
    assert.equal(box.children[0].attributes[1].value, "blocks:sand");
    assert.equal(rect.tag, "rect");
    assert.equal(src.slice(box.tagSpan.start, box.tagSpan.end), "@box");
    const tags: string[] = [];
    walkVcm(doc.elements, (e) => tags.push(e.tag));
    assert.deepEqual(tags, ["bone", "box", "part", "rect"]);
});

test("parses VCA keyframe syntax with bare-word values", () => {
    const src = [
        "@texture name $0 {",
        "    @key frame 0 value entities/tireman:face_0",
        "    @key frame 24 value entities/tireman:face_1",
        "}",
        "@move by y curve linear period 24 {",
        "    @key frame 0 value 0",
        "}",
    ].join("\n");
    const doc = parseVcm(src);
    assert.deepEqual(doc.errors, []);
    assert.equal(doc.elements[0].children[1].attributes[1].value, "entities/tireman:face_1");
    assert.equal(doc.elements[1].attributes.length, 3);
});

test("reports errors with positions and recovers", () => {
    const doc = parseVcm("@box from (0,0,0 to (1,1,1)\n@rect from (0,0,0)");
    assert.ok(doc.errors.length > 0);
    const unclosed = parseVcm("@bone name a {\n  @box from (0,0,0) to (1,1,1)\n");
    assert.equal(unclosed.errors[0].message, "'}' expected");
    assert.equal(unclosed.elements[0].children.length, 1);
    const junk = parseVcm("box from (0,0,0)\n@rect from (0,0,0)");
    assert.equal(junk.errors[0].message, "unexpected character in element");
    assert.equal(junk.elements.length, 1);
});

test("parseNumbers", () => {
    assert.deepEqual(parseNumbers("1, 2.5,-3"), [1, 2.5, -3]);
    assert.deepEqual(parseNumbers("2"), [2]);
    assert.equal(parseNumbers("1,,2"), undefined);
    assert.equal(parseNumbers("a,b"), undefined);
});
