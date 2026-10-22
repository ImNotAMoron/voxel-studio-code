// The debug adapter against a real headless engine (skipped without
// ../build/Debug/VoxelCore). The fixtures are app scripts (`--script`), whose
// chunk name is `script:<file name>`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EngineHandle, LaunchArguments, VoxelCoreDebugSession } from "../../src/debug/session";
import { freePort } from "../../src/debug/vcdbg";
import { REPO_ROOT, RES } from "../server/helpers";
import { ContentIndex } from "../../shared/content/index";
import { LogResolver } from "../../shared/log/resolve";

const EXE = path.join(REPO_ROOT, "build", "Debug", process.platform === "win32" ? "VoxelCore.exe" : "VoxelCore");
const FIXTURES = path.join(__dirname, "fixtures");
const skip = !fs.existsSync(EXE) && "engine not built";

/** Drives a session like VS Code: requests in, responses and events out. */
class Driver {
    private seq = 1;
    readonly events: any[] = [];
    private responses = new Map<number, any>();
    private waiters: (() => void)[] = [];
    readonly session: VoxelCoreDebugSession;
    proc?: ChildProcess;
    output = "";

    /** `project`: also pass `--project` (project: chunks resolve to it). */
    constructor(script: string, project?: string) {
        const resolver = project ? new LogResolver(new ContentIndex({ resPath: RES, roots: [project] }), { project, script }) : undefined;
        this.session = new VoxelCoreDebugSession(
            {
                launch: async (args: LaunchArguments): Promise<EngineHandle> => {
                    const port = await freePort();
                    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-dbg-"));
                    const entry = [...(project ? ["--project", project] : []), "--script", args.script!];
                    const proc = spawn(EXE, ["--headless", "--res", RES, "--dir", dir, ...entry, "--tps", "60", "--dbg-server", `tcp:${port}`]);
                    this.proc = proc;
                    proc.stdout!.on("data", (d) => (this.output += d));
                    proc.stderr!.on("data", (d) => (this.output += d));
                    const exited = new Promise<number | null>((resolve) => proc.on("exit", (code) => {
                        fs.rmSync(dir, { recursive: true, force: true });
                        resolve(code);
                    }));
                    return { port, isAlive: () => proc.exitCode === null, exited, kill: () => proc.kill() };
                },
                attach: async () => {
                    throw new Error("not used");
                },
                toVirtual: (file) => resolver ? resolver.virtualPath(file)
                    : path.resolve(file) === path.resolve(script) ? `script:${path.basename(file)}` : undefined,
                toFile: (vpath) => resolver ? resolver.resolveVirtual(vpath)
                    : vpath === `script:${path.basename(script)}` ? script : undefined,
            },
            (message) => {
                if (message.type === "response") this.responses.set(message.request_seq, message);
                else this.events.push(message);
                for (const w of this.waiters.splice(0)) w();
            }
        );
    }

    async request(command: string, args: any = {}): Promise<any> {
        const seq = this.seq++;
        void this.session.handleMessage({ seq, type: "request", command, arguments: args });
        await this.until(() => this.responses.has(seq), `${command} response`);
        const r = this.responses.get(seq);
        assert.ok(r.success, `${command}: ${r.message}`);
        return r.body;
    }

    private async until(pred: () => boolean, what: string, timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (!pred()) {
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}\nengine output:\n${this.output.slice(-3000)}`);
            await new Promise<void>((r) => {
                this.waiters.push(r);
                setTimeout(r, 100);
            });
        }
    }

    /** The next `stopped` event after the call; returns it and the top frame. */
    async stopped(action: () => Promise<unknown>): Promise<{ event: any; top: any; frames: any[] }> {
        const from = this.events.length;
        await action();
        await this.until(() => this.events.slice(from).some((e) => e.event === "stopped" || e.event === "terminated"), "stopped");
        const event = this.events.slice(from).find((e) => e.event === "stopped" || e.event === "terminated");
        assert.equal(event.event, "stopped", "the program ended instead of stopping");
        const { stackFrames } = await this.request("stackTrace", { threadId: 1 });
        return { event: event.body, top: stackFrames[0], frames: stackFrames };
    }

    async locals(frameId = 1): Promise<any[]> {
        const { scopes } = await this.request("scopes", { frameId });
        return (await this.request("variables", { variablesReference: scopes[0].variablesReference })).variables;
    }

    async end() {
        if (this.proc && this.proc.exitCode === null) {
            await this.request("disconnect", { terminateDebuggee: true });
            await this.until(() => this.proc!.exitCode !== null, "engine exit", 10000).catch(() => this.proc!.kill());
        }
    }
}

test("breakpoints, locals, table expansion, evaluate, stepping, pause", { skip, timeout: 120000 }, async () => {
    const script = path.join(FIXTURES, "loop.lua");
    const d = new Driver(script);
    try {
        await d.request("initialize", { adapterID: "voxelcore" });
        await d.request("launch", { mode: "headless", script });
        await d.request("setBreakpoints", { source: { path: script }, breakpoints: [{ line: 7 }] });
        let stop = await d.stopped(() => d.request("configurationDone"));
        assert.equal(stop.event.reason, "breakpoint");
        assert.deepEqual([stop.top.name, stop.top.line, stop.top.source.path], ["work", 7, script]);
        assert.equal(stop.frames[1].name, "main chunk");

        const locals = await d.locals();
        assert.deepEqual(locals.map((v) => v.name), ["n", "t"]);
        const t = locals.find((v) => v.name === "t");
        const fields = (await d.request("variables", { variablesReference: t.variablesReference })).variables;
        assert.deepEqual(fields.map((v: any) => `${v.name}=${v.value}`), ["a=" + locals[0].value, "list={...}"]);
        const list = (await d.request("variables", { variablesReference: fields[1].variablesReference })).variables;
        assert.deepEqual(list.map((v: any) => `${v.name}=${v.value}`), ["[1]=10", "[2]=20"]);
        assert.equal((await d.request("evaluate", { expression: "t.list[2]", frameId: 1, context: "hover" })).result, "20");
        // still stopped at the same place after get-value
        assert.equal((await d.request("stackTrace", { threadId: 1 })).stackFrames[0].line, 7);

        // next steps over helper(); twice in a row (the engine's own `step` works once)
        stop = await d.stopped(() => d.request("next", { threadId: 1 }));
        assert.deepEqual([stop.event.reason, stop.top.name, stop.top.line], ["step", "work", 8]);
        stop = await d.stopped(() => d.request("next", { threadId: 1 }));
        assert.deepEqual([stop.top.name, stop.top.line], ["work", 9]);
        // tables can't be expanded after a step (get-value would run a line)
        assert.equal((await d.locals()).find((v) => v.name === "t").variablesReference, 0);

        // step in → helper, step out → back in work
        stop = await d.stopped(() => d.request("continue", { threadId: 1 }));
        assert.deepEqual([stop.event.reason, stop.top.line], ["breakpoint", 7]);
        stop = await d.stopped(() => d.request("stepIn", { threadId: 1 }));
        assert.deepEqual([stop.top.name, stop.top.line], ["helper", 2]);
        stop = await d.stopped(() => d.request("stepOut", { threadId: 1 }));
        assert.equal(stop.top.name, "work");
        assert.ok([7, 8].includes(stop.top.line), `line ${stop.top.line}`);

        // pause without breakpoints: stops in Lua code, never inside the debugger itself
        await d.request("setBreakpoints", { source: { path: script }, breakpoints: [] });
        await d.request("continue", { threadId: 1 });
        await new Promise((r) => setTimeout(r, 300));
        stop = await d.stopped(() => d.request("pause", { threadId: 1 }));
        assert.equal(stop.event.reason, "pause");
        assert.ok(!/debugging\.lua$/.test(stop.top.source?.origin ?? ""), stop.top.source?.origin);
        await d.request("continue", { threadId: 1 });

        // breakpoints outside packs are rejected
        const bp = await d.request("setBreakpoints", { source: { path: path.join(os.tmpdir(), "x.lua") }, breakpoints: [{ line: 1 }] });
        assert.equal(bp.breakpoints[0].verified, false);
    } finally {
        await d.end();
    }
});

test("error() stops with the message; the filter can turn it off", { skip, timeout: 60000 }, async () => {
    const script = path.join(FIXTURES, "error.lua");
    const d = new Driver(script);
    try {
        await d.request("initialize", { adapterID: "voxelcore" });
        await d.request("launch", { mode: "headless", script });
        await d.request("setExceptionBreakpoints", { filters: ["error"] });
        const stop = await d.stopped(() => d.request("configurationDone"));
        assert.equal(stop.event.reason, "exception");
        assert.equal(stop.event.text, "fixture error: caught");
        assert.deepEqual([stop.top.name, stop.top.line], ["<anonymous>", 2]); // called through pcall: unnamed
        assert.equal((await d.request("exceptionInfo", { threadId: 1 })).description, "fixture error: caught");
    } finally {
        await d.end();
    }
    // with the filter off the engine still pauses; the adapter resumes at once
    const quiet = new Driver(script);
    try {
        await quiet.request("initialize", { adapterID: "voxelcore" });
        await quiet.request("launch", { mode: "headless", script });
        await quiet.request("setExceptionBreakpoints", { filters: [] });
        await quiet.request("configurationDone");
        await new Promise((r) => setTimeout(r, 2500));
        assert.ok(!quiet.events.some((e) => e.event === "stopped"));
        assert.ok(quiet.proc!.exitCode === null, "still running");
    } finally {
        await quiet.end();
    }
});

// headless, a project's own start.lua stops at its first yield (ServerMainloop needs
// --script, ENGINE_NOTES.md), so the project runs with its start.lua as the --script
test("project modules: breakpoints map through project: chunks", { skip, timeout: 60000 }, async () => {
    const project = path.join(FIXTURES, "project");
    const start = path.join(project, "start.lua");
    const module = path.join(project, "modules", "counter.lua");
    const d = new Driver(start, project);
    try {
        await d.request("initialize", { adapterID: "voxelcore" });
        await d.request("launch", { mode: "headless", script: start, project });
        const bp = await d.request("setBreakpoints", { source: { path: module }, breakpoints: [{ line: 4 }] });
        assert.equal(bp.breakpoints[0].verified, true);
        const stop = await d.stopped(() => d.request("configurationDone"));
        assert.equal(stop.event.reason, "breakpoint");
        assert.deepEqual([stop.top.name, stop.top.line, stop.top.source.path], ["bump", 4, module]);
        assert.equal(stop.frames[1].source.path, start);
        assert.equal(stop.frames[1].line, 4);
    } finally {
        await d.end();
    }
});
