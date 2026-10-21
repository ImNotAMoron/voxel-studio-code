import { test } from "node:test";
import assert from "node:assert/strict";
import {
    computeLuaSettings,
    ENGINE_GLOBALS,
    isPackManifest,
    isStaleMetaPath,
    mergeLuarc,
    RUNTIME_PATH,
} from "../../src/lua/settings";

const META = "C:\\Users\\u\\.vscode\\extensions\\voxelcore.voxelcore-tools-0.2.0\\meta";
const OLD = "C:\\Users\\u\\.vscode\\extensions\\voxelcore.voxelcore-tools-0.1.0\\meta";

test("stale meta detection", () => {
    assert.equal(isStaleMetaPath(OLD, META), true);
    assert.equal(isStaleMetaPath(META, META), false);
    assert.equal(isStaleMetaPath(META.replace(/\\/g, "/").toLowerCase(), META), false);
    assert.equal(isStaleMetaPath("C:/libs/my-lua-defs", META), false);
    assert.equal(isStaleMetaPath("/home/u/.vscode/extensions/voxelcore.voxelcore-tools-0.1.0/meta", META), true);
    // other folders of the old extension (not meta) are left alone
    assert.equal(isStaleMetaPath(OLD.replace(/meta$/, "other"), META), false);
});

test("fresh workspace", () => {
    const r = computeLuaSettings({}, { metaPath: META });
    assert.deepEqual(r.library, [META]);
    assert.deepEqual(r.globals, [...ENGINE_GLOBALS]);
    assert.equal(r.runtimeVersion, "LuaJIT");
    assert.deepEqual(r.runtimePath, [...RUNTIME_PATH]);
    assert.deepEqual(r.changed.sort(), ["globals", "library", "runtimePath", "runtimeVersion"]);
});

test("merge preserves user entries, dedupes and drops stale paths", () => {
    const r = computeLuaSettings(
        {
            library: ["/my/defs", OLD, META.toLowerCase()],
            globals: ["my_global", "PACK_ID"],
            runtimeVersion: "Lua 5.1",
            runtimePath: ["?.lua"],
            ignoreDir: [".vscode"],
        },
        { metaPath: META, ignoreDir: ["build"] }
    );
    assert.deepEqual(r.library, ["/my/defs", META.toLowerCase()]);
    assert.equal(r.globals[0], "my_global");
    assert.equal(r.globals.filter((g) => g === "PACK_ID").length, 1);
    assert.deepEqual(r.runtimePath, ["?.lua", ...RUNTIME_PATH]);
    assert.deepEqual(r.ignoreDir, [".vscode", "build"]);
    assert.ok(r.changed.includes("runtimeVersion"));
});

test("already configured: no changes", () => {
    const first = computeLuaSettings({}, { metaPath: META });
    const second = computeLuaSettings(
        {
            library: first.library,
            globals: first.globals,
            runtimeVersion: first.runtimeVersion,
            runtimePath: first.runtimePath,
        },
        { metaPath: META }
    );
    assert.deepEqual(second.changed, []);
});

test("legacy object-style library setting", () => {
    const r = computeLuaSettings({ library: { "/a": true, "/b": false } }, { metaPath: META });
    assert.deepEqual(r.library, ["/a", META]);
});

test(".luarc.json merge (nested, new file)", () => {
    const out = mergeLuarc(undefined, { metaPath: META });
    assert.equal((out.runtime as Record<string, unknown>).version, "LuaJIT");
    assert.deepEqual((out.workspace as Record<string, unknown>).library, [META]);
    assert.ok(typeof out.$schema === "string");
});

test(".luarc.json merge keeps existing keys", () => {
    const existing = {
        runtime: { version: "Lua 5.4", special: { include: "require" } },
        diagnostics: { globals: ["foo"], disable: ["lowercase-global"] },
        workspace: { library: [OLD, "/x"] },
        hint: { enable: true },
    };
    const out = mergeLuarc(existing, { metaPath: META }) as Record<string, Record<string, unknown>>;
    assert.equal(out.runtime.version, "Lua 5.4");
    assert.deepEqual(out.runtime.special, { include: "require" });
    assert.deepEqual(out.workspace.library, ["/x", META]);
    assert.equal((out.diagnostics.globals as string[])[0], "foo");
    assert.deepEqual(out.diagnostics.disable, ["lowercase-global"]);
    assert.deepEqual(out.hint, { enable: true });
    // input object is not mutated
    assert.deepEqual(existing.workspace.library, [OLD, "/x"]);
});

test(".luarc.json merge (dotted style)", () => {
    const out = mergeLuarc({ "runtime.version": "LuaJIT", "diagnostics.globals": ["a"] }, { metaPath: META });
    assert.deepEqual(out["diagnostics.globals"], ["a", ...ENGINE_GLOBALS]);
    assert.deepEqual(out["workspace.library"], [META]);
    assert.equal(out.workspace, undefined);
});

test("pack manifest detection", () => {
    assert.equal(isPackManifest({ id: "base", title: "Base" }, ["package.json", "blocks"]), true);
    assert.equal(isPackManifest({ id: "x" }, ["package.json", "src"]), false);
    assert.equal(isPackManifest({ name: "npm-pkg" }, ["scripts"]), false);
    assert.equal(isPackManifest({ id: "x", dependencies: { a: "1" } }, ["scripts"]), false);
});
