// Tests for the markdown signature parser of tools/gen-lua-meta.mjs, using
// snippets copied from doc/en.
import { before, test } from "node:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

interface Param {
    name: string;
    type: string;
    optional: boolean;
    desc: string;
}
interface Entry {
    kind: "function" | "field";
    path: string[];
    sep: "." | ":";
    name: string;
    params: Param[];
    returns: { type: string }[];
    fieldType?: string;
    desc: string[];
}
interface GenModule {
    mapType(raw: string, ctx?: { vecn?: string }): string;
    parseCodeBlock(
        lines: string[],
        opts?: { file?: string; after?: string[]; swapTypeAndName?: boolean }
    ): { entries: Entry[]; skipped: { line: string; reason: string }[] };
    extractBlocks(md: string): { lines: string[]; after: string[]; heading: string }[];
    parseUiTables(md: string, file: string): Entry[];
    parseLuaRegTables(src: string): Map<string, string[]>;
    parseOpenlibCalls(src: string): { lib: string; variable: string }[];
}

let gen: GenModule;
before(async () => {
    const genPath = path.resolve(__dirname, "..", "..", "tools", "gen-lua-meta.mjs");
    gen = (await import(pathToFileURL(genPath).href)) as GenModule;
});

const block = (text: string, opts = {}) => gen.parseCodeBlock(text.split("\n"), opts).entries;

test("simple signatures with comments and defaults (libblock.md)", () => {
    const entries = block(`-- Returns block string ID (name) by index.
block.name(blockid: int) -> str

-- Set block with given integer ID and state (default - 0) at given position.
-- If noupdate=true is passed, the \`on_update\` event will not be called for adjacent blocks.
block.set(x: int, y: int, z: int, id: int, states: int, noupdate: boolean=false)

-- playerid is optional
block.place(x: int, y: int, z: int, id: int, states: int, [optional] playerid: int)`);
    assert.equal(entries.length, 3);
    const [name, set, place] = entries;
    assert.deepEqual(name.path, ["block"]);
    assert.equal(name.name, "name");
    assert.deepEqual(name.params, [{ name: "blockid", type: "integer", optional: false, desc: "" }]);
    assert.deepEqual(name.returns, [{ type: "string" }]);
    assert.deepEqual(name.desc, ["Returns block string ID (name) by index."]);
    assert.equal(set.params.length, 6);
    assert.equal(set.params[5].name, "noupdate");
    assert.equal(set.params[5].type, "boolean");
    assert.equal(set.params[5].optional, true);
    assert.equal(set.desc.length, 2);
    assert.equal(place.params[5].optional, true);
    assert.equal(place.returns.length, 0);
});

test("multiple returns and overloads share a comment", () => {
    const entries = block(`-- Same for axis Y. Default: 0, 1, 0.
block.get_Y(x: int, y: int, z: int) -> int, int, int
block.get_Y(id: int, rotation: int) -> int, int, int`);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0].returns.map((r) => r.type), ["integer", "integer", "integer"]);
    assert.deepEqual(entries[1].desc, ["Same for axis Y. Default: 0, 1, 0."]);
});

test("fields", () => {
    const [materials, props] = block(`-- Table of materials by their full names (example: base:carpet)
block.materials: table<string, table>

-- Table of custom block properties (see ../../block-properties.md)
block.properties: table<int, table<string, object>>`);
    assert.equal(materials.kind, "field");
    assert.equal(materials.fieldType, "table<string, table>");
    assert.equal(props.fieldType, "table<integer, table<string, any>>");
});

test("multi-line signature with per-parameter comments (audio.md)", () => {
    const [e] = block(`audio.play_sound_2d(
    -- name of a loaded sound without pack prefix
    name: string,
    -- audio gain (0.0 - 1.0)
    volume: number
    -- audio playback speed (positive number)
    pitch: number,
    -- [optional] channel name: regular/ambient/music/ui (default - regular)
    channel: string,
    -- [optional] loop sound (default - false)
    loop: bool
) -> int`);
    assert.equal(e.name, "play_sound_2d");
    assert.deepEqual(e.params.map((p) => p.name), ["name", "volume", "pitch", "channel", "loop"]);
    assert.equal(e.params[1].desc, "audio gain (0.0 - 1.0)");
    assert.equal(e.params[3].optional, true);
    assert.equal(e.params[4].type, "boolean");
    assert.deepEqual(e.returns, [{ type: "integer" }]);
});

test("table types spanning lines, `-->` arrows and `name?:` params", () => {
    const [raycast] = block(`world.raycast(
    params: table {
        -- starting point
        start: vec3,
        entities: bool = true,
    }
) -> table`);
    assert.equal(raycast.params.length, 1);
    assert.equal(raycast.params[0].type, "table");
    const [peek] = block(`server:is_open() --> bool`);
    assert.equal(peek.sep, ":");
    assert.deepEqual(peek.returns, [{ type: "boolean" }]);
    const [faces] = block(`gfx.blockwraps.set_faces(
    id: int,
    face1?: string,
    face2?: string,
    ...
    face6?: string
)`);
    assert.deepEqual(faces.params.map((p) => p.name), ["id", "face1", "face2", "face3", "face4", "face5", "face6"]);
    assert.ok(faces.params.slice(1).every((p) => p.optional && p.type === "string"));
});

test("methods, embedded signatures and example code", () => {
    const entries = block(`-- Alias
local tsf = entity.transform

-- Returns the position of the entity
tsf:get_pos() -> vec3
-- Sets the entity position
tsf:set_pos(pos:vec3)

-- Returns a table containing all keys of the given table, including numeric ones. table.keys(t: table) -> table

local hash = crypto.hash_new("SHA256")
rng:seed(42)`);
    const names = entries.map((e) => `${e.path.join(".")}${e.sep}${e.name}`);
    assert.deepEqual(names, ["tsf:get_pos", "tsf:set_pos", "table.keys"]);
    assert.deepEqual(entries[0].returns, [{ type: "vec3" }]);
    assert.deepEqual(entries[2].desc, ["Returns a table containing all keys of the given table, including numeric ones."]);
});

test("description from the paragraph after the block (libfile.md)", () => {
    const md = "```python\nfile.read(path: str) -> str\n```\n\nRead whole text file.\n\n```lua\nfile.exists(path: str) -> bool\n```\n";
    const blocks = gen.extractBlocks(md);
    assert.equal(blocks.length, 2);
    const [e] = gen.parseCodeBlock(blocks[0].lines, { after: blocks[0].after }).entries;
    assert.deepEqual(e.desc, ["Read whole text file."]);
});

test("module docs with type-first parameters", () => {
    const [e] = block("function data_buffer:put_byte(integer: byte)", { swapTypeAndName: true });
    assert.deepEqual(e.params[0], { name: "byte", type: "integer", optional: false, desc: "" });
    const [v] = block("function vector2:abtw(vector: vec2) -> number", { swapTypeAndName: true });
    assert.equal(v.params[0].name, "vector");
    assert.equal(v.params[0].type, "vec2");
});

test("type mapping", () => {
    assert.equal(gen.mapType("int"), "integer");
    assert.equal(gen.mapType("str"), "string");
    assert.equal(gen.mapType("bool"), "boolean");
    assert.equal(gen.mapType("vec3"), "vec3");
    assert.equal(gen.mapType("matrix"), "mat4");
    assert.equal(gen.mapType("vector", { vecn: "vec2" }), "vec2");
    assert.equal(gen.mapType("nil|table|Bytearray"), "nil|table|Bytearray");
    assert.equal(gen.mapType("component or nil"), "table|nil");
    assert.equal(gen.mapType("{int, int, int}"), "integer[]");
    assert.equal(gen.mapType("{rotation: int, segment: int}"), "{ rotation: integer, segment: integer }");
    assert.equal(gen.mapType("array of integers"), "integer[]");
    assert.equal(gen.mapType("tables array { name: str }"), "table[]");
    assert.equal(gen.mapType("table<string>"), "string[]");
    assert.equal(gen.mapType("function() -> number, number"), "function");
    assert.equal(gen.mapType("Heightmap|number"), "Heightmap|number");
    assert.equal(gen.mapType("whatever"), "any");
});

test("ui.md tables become Element / Canvas members", () => {
    const md = `## Textbox

| Name        | Type   | Read | Write | Description                 |
| ----------- | ------ | ---- | ----- | --------------------------- |
| text        | string | yes  | yes   | entered text or placeholder |
| valid       | bool   | yes  | no    | is the entered text correct |

| Method                    | Description                                         |
| ------------------------- | --------------------------------------------------- |
| lineAt(pos: int) -> int   | determines the line number by position in the text  |
| data:set_data(data: Bytearray | table<int>)  | replaces pixel data             |
`;
    const entries = gen.parseUiTables(md, "ui.md");
    assert.equal(entries.length, 4);
    assert.equal(entries[1].fieldType, "boolean");
    assert.match(entries[1].desc[0], /read-only/);
    assert.equal(entries[2].name, "lineAt");
    assert.deepEqual(entries[2].path, ["Element"]);
    assert.deepEqual(entries[3].path, ["Canvas"]);
    assert.equal(entries[3].params[0].type, "Bytearray|integer[]");
});

test("luaL_Reg tables with macros and openlib calls", () => {
    const src = `
#define VECLIB_BASE(n) \\
{"add", lua::wrap<l_add<n>>},                   \\
{"sub", lua::wrap<l_sub<n>>},

const luaL_Reg vec2lib[] = {
    VECLIB_BASE(2)
    {"angle", lua::wrap<l_vec2_angle>},
    {nullptr, nullptr}
};
`;
    const tables = gen.parseLuaRegTables(src);
    assert.deepEqual(tables.get("vec2lib")?.sort(), ["add", "angle", "sub"]);
    const calls = gen.parseOpenlibCalls(`openlib(L, "vec2", vec2lib);\n lua::openlib(L, "gfx", "particles", particleslib);`);
    assert.deepEqual(calls.map((c) => [c.lib, c.variable]), [["vec2", "vec2lib"], ["gfx.particles", "particleslib"]]);
});
