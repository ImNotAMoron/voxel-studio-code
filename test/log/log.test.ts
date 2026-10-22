// Engine log → problems. The logs in fixtures/logs/ are real engine output
// (VoxelCore 0.32, headless) for the pack in fixtures/broken/, recorded with
// one error scenario each. To re-record, copy fixtures/broken into
// <userdir>/content/, delete the files named in each scenario below and run
//   VoxelCore --headless --res res --dir <userdir> --script <app.lua>
// with an app script that calls app.reconfig_packs({"base", "broken"}, {}),
// app.new_world("t", "1", "core:default"), app.tick() a few times and app.quit().
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex } from "../../shared/content/index";
import { LogParser, parseLog } from "../../shared/log/parse";
import { LogContext, cleanMessage, problemOf, type RuntimeProblem } from "../../shared/log/problems";
import { LogResolver } from "../../shared/log/resolve";
import { findLogLinks } from "../../shared/log/links";
import { RES } from "../server/helpers";

const FIXTURES = path.join(__dirname, "fixtures");
const PACK = path.join(FIXTURES, "broken");
const index = new ContentIndex({ resPath: RES, packDirs: [PACK] });
const resolver = new LogResolver(index, { userDir: path.join(FIXTURES, "user"), script: path.join(FIXTURES, "app.lua") });

/** file (relative to the pack) → "line: message" (1-based), like the Problems panel. */
function problems(log: string): { problems: RuntimeProblem[]; located: string[] } {
    const ctx = new LogContext();
    const result: RuntimeProblem[] = [];
    for (const entry of parseLog(fs.readFileSync(path.join(FIXTURES, "logs", log), "utf8"))) {
        ctx.observe(entry);
        const p = problemOf(entry, ctx);
        if (p) result.push(p);
    }
    const located = new Set<string>();
    for (const p of result) {
        const loc = p.target && resolver.resolve(p.target);
        if (loc) located.add(`${path.relative(PACK, loc.file).replace(/\\/g, "/")}:${loc.start.line + 1}:${loc.start.character + 1} ${p.message}`);
    }
    return { problems: result, located: [...located] };
}

test("parses headers, levels, padded modules and multi-line entries", () => {
    const entries = parseLog(
        "[I] 2026/10/22 10:44:22.644+0300 [      content-loader] loading pack [broken]\n" +
            "[E] 2026/10/22 10:46:24.566+0300 [           lua-debug] error in event (broken:.worldopen) handler: x\n" +
            "stack traceback:\n" +
            "\t[string \"broken:scripts/world.lua\"]:3: in function <...>\n" +
            "hello from print\n" +
            "[lua]    printed through LogLevel::print\n"
    );
    assert.deepEqual(entries.map((e) => [e.level, e.module, e.details.length]), [
        ["info", "content-loader", 0],
        ["error", "lua-debug", 2],
        ["print", "", 0],
        ["print", "lua", 0],
    ]);
    assert.equal(entries[0].message, "loading pack [broken]");
    assert.equal(entries[0].time, "2026/10/22 10:44:22.644+0300");
});

test("streaming parser keeps partial lines and continuations across chunks", () => {
    const got: string[] = [];
    const parser = new LogParser((e) => got.push(`${e.level}:${e.message}:${e.details.length}`));
    parser.push("[E] 2026/10/22 10:46:24.566+0300 [           lua-debug] boom\nstack trace");
    parser.push("back:\n\tframe 1\n");
    assert.deepEqual(got, [], "the entry may still continue");
    parser.push("[I] 2026/10/22 10:46:24.567+0300 [x] next\r\n");
    assert.deepEqual(got, ["error:boom:2"]);
    parser.flush();
    assert.deepEqual(got, ["error:boom:2", "info:next:0"]);
});

test("cleanMessage strips handler prefixes and Lua locations", () => {
    assert.equal(
        cleanMessage('error in event (broken:.worldtick) handler: [string "core:modules/internal/debugging.lua"]:149: tick failure'),
        "tick failure"
    );
    assert.equal(cleanMessage('[string "core:x.lua"]:1: [string "script:app.lua"]:2: file "a:b.json": bad'), 'file "a:b.json": bad');
});

test("JSON parse errors point at the reported position (engine line is off by one)", () => {
    const { located } = problems("parse.log");
    assert.equal(located.length, 1, located.join("\n"));
    assert.match(located[0], /^blocks\/badjson\.json:3:5 '"' expected$/);
});

/** Logged in every scenario after the parse error (these units load before the failing one). */
const ENUM_ERRORS = [
    "blocks/badmodel.json:2:14 unknown model: cubee",
    "blocks/badrot.json:2:17 unknown rotation profile spin",
    "blocks/badrot.json:3:16 unknown culling mode: weird",
];
/** Items load after all blocks, so these appear once the blocks load. */
const ITEM_ERRORS = [
    "items/baditem.json:2:18 broken:baditem: unknown icon type - weird",
    "items/baditem.json:3:21 broken:baditem: unknown uses display mode - bad",
];
const without = (list: string[], known: string[]) => list.filter((l) => !known.includes(l)).sort();

test("enum errors are found in the pack being loaded; unresolved parents too", () => {
    const { located } = problems("unresolved.log");
    assert.deepEqual(located.sort(), [
        ...ENUM_ERRORS,
        "blocks/orphan.json:2:15 Unresolved blocks dependencies detected. (a 'parent' that isn't loaded yet)",
    ]);
    assert.deepEqual(without(problems("syntax.log").located, ENUM_ERRORS).filter((l) => l.startsWith("items/")), ITEM_ERRORS);
});

test("loader errors wrapped with the file path", () => {
    const { located, problems: list } = problems("typeerror.log");
    assert.deepEqual(without(located, ENUM_ERRORS), ["blocks/badtypes.json:1:1 type error: expected integer, got string"]);
    // the app script frame (the `new_world` call) is kept as related information
    assert.ok(list.some((p) => p.frames.some((f) => f.vpath.startsWith("script:") && f.line === 2)));
});

test("Lua syntax errors in block scripts", () => {
    const { located } = problems("syntax.log");
    assert.deepEqual(without(located, [...ENUM_ERRORS, ...ITEM_ERRORS]), ["scripts/syntaxerr.lua:2:1 '(' expected near 'on_placed'"]);
});

test("missing entity components point at the components entry", () => {
    const { located } = problems("component.log");
    assert.deepEqual(without(located, [...ENUM_ERRORS, ...ITEM_ERRORS]), [
        "entities/bot.json:2:35 component broken:missing_comp is not available (required by entity broken:bot)",
    ]);
});

test("runtime errors use the first frame outside core (error() is wrapped by debugging.lua)", () => {
    const { located } = problems("runtime.log");
    assert.deepEqual(without(located, [...ENUM_ERRORS, ...ITEM_ERRORS]), [
        "scripts/components/comp.lua:2:5 attempt to perform arithmetic on a table value",
        "scripts/world.lua:10:5 script 'modules/nomodule.lua' not found in 'broken'",
        "scripts/world.lua:11:5 tick failure",
        "scripts/world.lua:4:5 attempt to index local 't' (a nil value)",
    ]);
});

test("virtual paths: pack ids, linked user content, core and the app script", () => {
    assert.equal(resolver.resolveVirtual("broken:scripts/world.lua"), path.join(PACK, "scripts", "world.lua"));
    assert.equal(resolver.resolveVirtual("user:content/broken/blocks/badmodel.json"), path.join(PACK, "blocks", "badmodel.json"));
    assert.equal(resolver.resolveVirtual("world:content/broken/blocks/badmodel.json"), path.join(PACK, "blocks", "badmodel.json"));
    assert.equal(resolver.resolveVirtual("core:scripts/stdlib.lua"), path.join(RES, "scripts", "stdlib.lua"));
    assert.equal(resolver.resolveVirtual("res:content/base/blocks/stone.json"), path.join(RES, "content", "base", "blocks", "stone.json"));
    assert.equal(resolver.resolveVirtual("broken:scripts/missing.lua"), undefined);
    assert.equal(resolver.resolveVirtual("nosuchpack:x.lua"), undefined);
});

test("links in log lines", () => {
    const line = '[E] ... [string "broken:scripts/world.lua"]:4: attempt; file "user:content/broken/blocks/a.json": x; see base:textures/blocks/stone.png at C:\\Users\\x.png';
    assert.deepEqual(findLogLinks(line).map((l) => [l.vpath, l.line, line.slice(l.start, l.start + l.length)]), [
        ["broken:scripts/world.lua", 4, '[string "broken:scripts/world.lua"]:4'],
        ["user:content/broken/blocks/a.json", undefined, 'file "user:content/broken/blocks/a.json"'],
        ["base:textures/blocks/stone.png", undefined, "base:textures/blocks/stone.png"],
    ]);
    assert.deepEqual(findLogLinks("https://example.com/a.json"), []);
});

test("project chunks: project:<path> and the bare project_client.lua", () => {
    const project = path.join(__dirname, "..", "server", "fixtures", "errproject");
    const pindex = new ContentIndex({ resPath: RES, roots: [project] });
    const r = new LogResolver(pindex, { project });
    assert.equal(r.resolveVirtual("project:start.lua"), path.join(project, "start.lua"));
    assert.equal(r.resolveVirtual("project:modules/helper.lua"), path.join(project, "modules", "helper.lua"));
    assert.equal(r.resolveVirtual("project_client.lua"), path.join(project, "project_client.lua"));
    assert.equal(r.virtualPath(path.join(project, "start.lua")), "project:start.lua");
    assert.equal(r.virtualPath(path.join(project, "modules", "helper.lua")), "project:modules/helper.lua");
    assert.equal(r.virtualPath(path.join(project, "project_client.lua")), "project_client.lua");
    // packs in the project's content/ keep their pack chunk names
    assert.equal(r.virtualPath(path.join(project, "content", "projpack", "scripts", "world.lua")), "projpack:scripts/world.lua");
    // without a --project run, project: chunks don't resolve
    assert.equal(new LogResolver(pindex, {}).resolveVirtual("project:start.lua"), undefined);
});

test("project script errors map to the project's files (real client log)", () => {
    // fixtures/logs/project.log: a windowed run with --project, an error in
    // project_client.lua on_menu_setup (line 3) and in start.lua (line 3)
    const project = path.join(__dirname, "..", "server", "fixtures", "errproject");
    const r = new LogResolver(new ContentIndex({ resPath: RES, roots: [project] }), { project });
    const ctx = new LogContext();
    const located: string[] = [];
    for (const entry of parseLog(fs.readFileSync(path.join(FIXTURES, "logs", "project.log"), "utf8"))) {
        ctx.observe(entry);
        const p = problemOf(entry, ctx);
        const loc = p?.target && r.resolve(p.target);
        if (loc) located.push(`${path.relative(project, loc.file).split(path.sep).join("/")}:${loc.start.line + 1} ${p!.message}`);
    }
    assert.deepEqual(located, [
        "project_client.lua:3 attempt to index local 'x' (a nil value)",
        "start.lua:3 attempt to index local 't' (a nil value)",
    ]);
});
