import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ContentIndex } from "../../shared/content/index";
import { markDebuggerReady, sendBridgeRequest, waitForAck } from "../../src/hotreload/bridge";
import { enginePaths, reloadActionFor } from "../../src/hotreload/plan";
import { quickWorldScript } from "../../src/run/userdir";
import { GOODPACK, REPO_ROOT, RES } from "../server/helpers";

const EXE = path.join(REPO_ROOT, "build", "Debug", process.platform === "win32" ? "VoxelCore.exe" : "VoxelCore");
const HOTPACK = path.join(__dirname, "fixtures", "hotpack");

test("reload actions per file kind", () => {
    const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK] });
    const act = (rel: string) => {
        const a = reloadActionFor(index, path.join(GOODPACK, rel));
        return a && (a.kind === "asset" ? `asset ${a.files.join(" ")}` : a.kind === "module" ? `module ${a.name}` : a.kind);
    };
    assert.equal(act("textures/gui/goodpack_logo.png"), "asset user:content/goodpack/textures/gui/goodpack_logo.png");
    assert.equal(act("textures/blocks/crate.png"), "restart");
    assert.equal(act("models/statue.vcm"), "asset user:content/goodpack/models/statue.vcm");
    assert.equal(act("animation/wave.vca"), "asset user:content/goodpack/animation/wave.vca");
    assert.equal(act("modules/util.lua"), "module goodpack:util");
    assert.equal(act("blocks/crate.json"), "content");
    assert.equal(act("scripts/crate.lua"), "content");
    assert.equal(act("layouts/crate.xml"), "content");
    assert.equal(act("sounds/crate/open_0.ogg"), "restart");
    assert.equal(act("content.json"), undefined);
    // the engine's own files are res: paths
    assert.deepEqual(enginePaths(index, path.join(RES, "textures", "gui", "menubg.png")), ["res:textures/gui/menubg.png"]);
});

test("dev bridge: waits for the debugger, reloads a module and the content", { skip: !fs.existsSync(EXE) && "engine not built", timeout: 120000 }, async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-bridge-"));
    const pack = path.join(userDir, "content", "hotpack");
    fs.cpSync(HOTPACK, pack, { recursive: true });
    const script = path.join(userDir, "quick_world.lua");
    fs.writeFileSync(script, quickWorldScript({
        world: "hot", seed: "1", generator: "core:default", packs: ["hotpack"], recreate: true, waitForDebugger: true, bridge: true,
    }));
    let output = "";
    const proc = spawn(EXE, ["--headless", "--res", RES, "--dir", userDir, "--script", script, "--tps", "60"]);
    proc.stdout.on("data", (d) => (output += d));
    proc.stderr.on("data", (d) => (output += d));
    const until = async (what: string, pred: () => boolean, ms = 30000) => {
        const deadline = Date.now() + ms;
        while (!pred()) {
            if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`${what}\n${output.slice(-3000)}`);
            await new Promise((r) => setTimeout(r, 100));
        }
    };
    try {
        await new Promise((r) => setTimeout(r, 2500));
        assert.ok(!output.includes("greet "), "the world opened before the debugger was ready");
        markDebuggerReady(userDir, 2);
        await until("world with v1", () => output.includes("greet v1"));

        fs.writeFileSync(path.join(pack, "modules", "greet.lua"), 'local this = {}\nfunction this.msg() return "v2" end\nreturn this\n');
        let ack = await waitForAck(userDir, sendBridgeRequest(userDir, { op: "reload_module", name: "hotpack:greet" }));
        assert.deepEqual(ack && [ack.ok, ack.error], [true, undefined], output.slice(-2500));
        await until("reloaded module", () => output.includes("greet v2"));

        fs.writeFileSync(path.join(pack, "scripts", "world.lua"), 'function on_world_tick() print("content reloaded") end\n');
        ack = await waitForAck(userDir, sendBridgeRequest(userDir, { op: "reload_content" }), 30000);
        assert.deepEqual(ack && [ack.ok, ack.error], [true, undefined]);
        await until("reloaded world script", () => output.includes("content reloaded"));

        // failures are reported back
        ack = await waitForAck(userDir, sendBridgeRequest(userDir, { op: "reload_module", name: "hotpack:missing" }));
        assert.ok(ack, "ack for a module that isn't loaded");
    } finally {
        proc.kill();
        await new Promise((r) => setTimeout(r, 500));
        fs.rmSync(userDir, { recursive: true, force: true });
    }
});
