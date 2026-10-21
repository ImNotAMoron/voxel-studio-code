import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../../server/src/cli";
import { BACKROOMS, BASE, ERRPACK, GOODPACK, RES } from "./helpers";

test("cli: errors give exit code 1 and file:line:col output", () => {
    const r = runCli(["lint", ERRPACK, "--res", RES]);
    assert.equal(r.exitCode, 1);
    assert.match(r.output, /bad\.json:2:16: warning VC0020 block texture 'nope' not found/);
    assert.match(r.output, /error VC0010 unknown property method/);
    assert.match(r.output, /\d+ error\(s\)/);
});

test("cli: clean packs exit 0", () => {
    assert.equal(runCli(["lint", GOODPACK, "--res", RES]).exitCode, 0);
    const r = runCli(["lint", BASE, BACKROOMS, "--res", RES, "--no-hints"]);
    assert.equal(r.exitCode, 0, r.output);
    assert.match(r.output, /^0 error\(s\), 0 warning\(s\)/m);
});

test("cli: json format", () => {
    const r = runCli(["lint", ERRPACK, "--res", RES, "--format", "json"]);
    const records = JSON.parse(r.output) as { code: string; line: number; href: string }[];
    assert.ok(records.length > 50);
    assert.ok(records.every((x) => x.line >= 1 && x.href.startsWith("https://github.com/MihailRis/VoxelCore/blob/main/")));
});

test("cli: usage errors", () => {
    assert.equal(runCli([]).exitCode, 2);
    assert.equal(runCli(["lint", RES]).exitCode, 2, "res/ itself is not a pack");
    assert.equal(runCli(["rules"]).exitCode, 0);
});
