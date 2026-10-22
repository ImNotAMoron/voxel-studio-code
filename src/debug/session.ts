// Debug adapter for VoxelCore Lua over VC-DBG (FEATURES.md §4.4). Pure: it
// speaks DAP through `send` and the engine through `VcDbgClient`, so the
// tests drive it without VS Code (src/debug/index.ts runs it inline).
//
// The engine's debugger has limits this adapter works around (ENGINE_NOTES.md):
// - `step` only works once after a breakpoint, so next / step in / step out
//   are built from `step-into-function` (pause at the next Lua line) plus
//   stack-depth checks;
// - `pause` isn't implemented, `step-into-function` pauses instead;
// - `get-value` resumes the program unless it's paused at a breakpoint, so
//   tables can be expanded only at breakpoints.
import * as path from "node:path";
import { PausedMessage, ServerMessage, StackFrame, VcDbgClient } from "./vcdbg";

type Json = Record<string, any>;

export interface DapRequest {
    seq: number;
    type: "request";
    command: string;
    arguments?: Json;
}

export interface LaunchArguments {
    mode?: "quickWorld" | "run" | "headless";
    world?: string;
    generator?: string;
    seed?: string;
    recreate?: boolean;
    script?: string;
    args?: string[];
    project?: string;
    projectArgs?: string[];
    port?: number;
    host?: string;
    /** quickWorld: the app script waits for the debugger before opening the world. */
    waitForDebugger?: boolean;
}

/** A running engine to debug. */
export interface EngineHandle {
    port: number;
    host?: string;
    /** An already open connection (a run's hot-reload client) to take over. */
    client?: VcDbgClient;
    isAlive(): boolean;
    /** Resolves when the process exits (launch only). */
    exited?: Promise<number | null>;
    kill?(): void;
    /** The breakpoints were sent: `messages` were queued before the program may continue. */
    configured?(messages: number): void;
    /** On detach: take the connection back (true) instead of closing it. */
    release?(client: VcDbgClient): boolean;
}

export interface SessionHost {
    launch(args: LaunchArguments, output: (text: string) => void): Promise<EngineHandle>;
    attach(args: LaunchArguments): Promise<EngineHandle>;
    /** Workspace file → chunk name (`pack:scripts/x.lua`). */
    toVirtual(file: string): string | undefined;
    /** Chunk name → workspace or engine file. */
    toFile(vpath: string): string | undefined;
}

const THREAD_ID = 1;
/** Inline debugger code; never shown and always stepped through. */
const INTERNAL = /^core:modules\/internal\/debugging\.lua$/;
/** Engine code (res/): stepping leaves it instead of walking through it line by line. */
const ENGINE_CODE = /^(core|res):/;
/** Line pauses a single step may take before giving up (each costs an engine frame). */
const STEP_BUDGET = 400;

type Handle =
    | { kind: "locals"; frame: number }
    | { kind: "value"; frame: number; local: number; path: (string | number)[] };

interface Stepping {
    mode: "over" | "in" | "out" | "pause";
    depth: number;
    source?: string;
    line?: number;
    engineOrigin: boolean;
    budget: number;
}

export class VoxelCoreDebugSession {
    private seq = 1;
    private client?: VcDbgClient;
    private handle?: EngineHandle;
    private request: "launch" | "attach" = "launch";
    private configured = false;
    private connected = false;
    private ending = false;
    /** User breakpoints: chunk name → lines. */
    private readonly breakpoints = new Map<string, Set<number>>();
    private readonly sentBreakpoints = new Map<string, Set<number>>();
    private stopOnError = true;
    private paused?: PausedMessage;
    /** Tables can be expanded (stopped at a breakpoint). */
    private valuesAllowed = false;
    private stepping?: Stepping;
    /** The next `paused` repeats the stop at the same line (step then breakpoint). */
    private spurious?: { source?: string; line?: number };
    private handles = new Map<number, Handle>();
    private nextHandle = 1;
    private valueQueue: Promise<unknown> = Promise.resolve();
    private pendingValue?: { resolve: (v: unknown) => void };
    private absorbPauses = 0;

    constructor(
        private readonly host: SessionHost,
        private readonly sendMessage: (message: Json) => void
    ) {}

    // ---- DAP plumbing

    private respond(req: DapRequest, body?: Json) {
        this.sendMessage({ seq: this.seq++, type: "response", request_seq: req.seq, success: true, command: req.command, body });
    }

    private fail(req: DapRequest, message: string) {
        this.sendMessage({
            seq: this.seq++, type: "response", request_seq: req.seq, success: false, command: req.command, message,
            body: { error: { id: 1, format: message, showUser: true } },
        });
    }

    private event(event: string, body?: Json) {
        this.sendMessage({ seq: this.seq++, type: "event", event, body });
    }

    output(text: string, category: "stdout" | "stderr" | "console" | "important" = "stdout") {
        this.event("output", { category, output: text });
    }

    async handleMessage(message: Json): Promise<void> {
        if (message.type !== "request") return;
        const req = message as DapRequest;
        try {
            await this.dispatch(req);
        } catch (err) {
            this.fail(req, (err as Error).message);
        }
    }

    private async dispatch(req: DapRequest) {
        const args = req.arguments ?? {};
        switch (req.command) {
            case "initialize":
                this.respond(req, {
                    supportsConfigurationDoneRequest: true,
                    supportsEvaluateForHovers: true,
                    supportsTerminateRequest: true,
                    supportsExceptionInfoRequest: true,
                    exceptionBreakpointFilters: [
                        { filter: "error", label: "error() calls", default: true, description: "Stop when Lua code calls error()" },
                    ],
                });
                // "initialized" follows launch/attach: breakpoints need the chunk names known then
                return;
            case "launch":
            case "attach":
                return this.start(req, args as LaunchArguments);
            case "setBreakpoints":
                return this.setBreakpoints(req, args);
            case "setExceptionBreakpoints":
                this.stopOnError = (args.filters ?? []).includes("error");
                this.respond(req);
                return;
            case "configurationDone":
                this.configured = true;
                this.respond(req);
                this.flushBreakpoints();
                return;
            case "threads":
                this.respond(req, { threads: [{ id: THREAD_ID, name: "main" }] });
                return;
            case "stackTrace":
                return this.stackTrace(req, args);
            case "scopes": {
                const frame = Number(args.frameId) - 1;
                this.respond(req, {
                    scopes: [{ name: "Locals", presentationHint: "locals", variablesReference: this.newHandle({ kind: "locals", frame }), expensive: false }],
                });
                return;
            }
            case "variables":
                return this.variables(req, args);
            case "evaluate":
                return this.evaluate(req, args);
            case "exceptionInfo":
                this.respond(req, { exceptionId: "error", description: this.paused?.message ?? "", breakMode: "always" });
                return;
            case "continue":
                this.resume();
                this.respond(req, { allThreadsContinued: true });
                return;
            case "next":
                this.respond(req);
                this.step("over");
                return;
            case "stepIn":
                this.respond(req);
                this.step("in");
                return;
            case "stepOut":
                this.respond(req);
                this.step("out");
                return;
            case "pause":
                this.respond(req);
                if (!this.paused) this.step("pause");
                return;
            case "terminate":
                this.respond(req);
                this.terminate();
                return;
            case "disconnect":
                this.respond(req);
                this.disconnect(args.terminateDebuggee ?? this.request === "launch");
                return;
            default:
                this.fail(req, `unsupported request '${req.command}'`);
        }
    }

    // ---- lifecycle

    private async start(req: DapRequest, args: LaunchArguments) {
        this.request = req.command as "launch" | "attach";
        const handle = this.request === "launch"
            ? await this.host.launch(args, (text) => this.output(text))
            : await this.host.attach(args);
        this.handle = handle;
        handle.exited?.then((code) => {
            this.event("exited", { exitCode: code ?? 0 });
            this.end();
        });
        const client = handle.client ?? await VcDbgClient.connect(handle.port, {
            host: handle.host,
            isAlive: () => handle.isAlive(),
            disconnectAction: this.request === "launch" ? "terminate" : "resume",
        });
        this.client = client;
        this.connected = true;
        client.on("message", (m) => this.onEngineMessage(m));
        client.on("close", () => {
            if (this.client === client) this.end();
        });
        this.respond(req);
        this.event("initialized");
        this.flushBreakpoints();
    }

    private end() {
        if (this.ending) return;
        this.ending = true;
        this.event("terminated");
    }

    private terminate() {
        this.client?.send({ type: "terminate" });
        const handle = this.handle;
        if (handle?.kill) setTimeout(() => handle.isAlive() && handle.kill!(), 3000);
    }

    private disconnect(terminate: boolean) {
        const client = this.client;
        if (!client) return;
        if (terminate) {
            this.terminate();
            return;
        }
        // leave the program running: no breakpoints, no step mode
        for (const [source, lines] of this.sentBreakpoints) for (const line of lines) client.send({ type: "remove-breakpoint", source, line });
        this.sentBreakpoints.clear();
        client.send({ type: "resume" });
        this.client = undefined;
        if (!this.handle?.release?.(client)) {
            client.send({ type: "detach" });
            setTimeout(() => client.close(), 500);
        }
        this.end();
    }

    // ---- breakpoints

    private setBreakpoints(req: DapRequest, args: Json) {
        const file = args.source?.path as string | undefined;
        const lines: number[] = (args.breakpoints ?? []).map((b: Json) => Number(b.line));
        const vpath = file ? this.host.toVirtual(file) : undefined;
        if (!vpath) {
            this.respond(req, {
                breakpoints: lines.map((line) => ({ verified: false, line, message: "Not a file of a content pack or of the engine's res/ folder" })),
            });
            return;
        }
        this.breakpoints.set(vpath, new Set(lines));
        this.flushBreakpoints();
        this.respond(req, { breakpoints: lines.map((line) => ({ verified: true, line, source: args.source })) });
    }

    /** Sends the difference between wanted and sent breakpoints. */
    private flushBreakpoints() {
        const client = this.client;
        if (!client || !this.connected) return;
        let messages = 0;
        for (const source of new Set([...this.breakpoints.keys(), ...this.sentBreakpoints.keys()])) {
            const want = this.breakpoints.get(source) ?? new Set<number>();
            const sent = this.sentBreakpoints.get(source) ?? new Set<number>();
            for (const line of sent) if (!want.has(line)) {
                client.send({ type: "remove-breakpoint", source, line });
                messages++;
            }
            for (const line of want) if (!sent.has(line)) {
                client.send({ type: "set-breakpoint", source, line });
                messages++;
            }
            this.sentBreakpoints.set(source, new Set(want));
        }
        if (this.configured) {
            const handle = this.handle;
            this.configured = false; // report once
            handle?.configured?.(messages);
        }
    }

    private hasBreakpoint(source: string | undefined, line: number | undefined): boolean {
        return !!source && line !== undefined && !!this.breakpoints.get(source)?.has(line);
    }

    // ---- execution control

    private clearStop() {
        this.paused = undefined;
        this.valuesAllowed = false;
        this.handles.clear();
    }

    private resume() {
        const top = this.paused?.stack?.[0];
        // stopped by a step on a line with a breakpoint: the engine pauses there again
        if (this.paused?.reason === "step" && this.hasBreakpoint(top?.source, top?.line)) {
            this.spurious = { source: top?.source, line: top?.line };
        }
        this.stepping = undefined;
        this.clearStop();
        this.client?.send({ type: "resume" });
    }

    private step(mode: Stepping["mode"]) {
        const stack = this.paused?.stack ?? [];
        const top = stack[0];
        if (this.paused?.reason === "step" && this.hasBreakpoint(top?.source, top?.line)) {
            this.spurious = { source: top?.source, line: top?.line };
        }
        this.stepping = {
            mode,
            depth: stack.length,
            source: top?.source,
            line: top?.line,
            engineOrigin: !!top?.source && ENGINE_CODE.test(top.source),
            budget: STEP_BUDGET,
        };
        this.clearStop();
        this.client?.send({ type: "step-into-function" });
    }

    private onEngineMessage(m: ServerMessage) {
        switch (m.type) {
            case "value":
                if (this.pendingValue) {
                    const pending = this.pendingValue;
                    this.pendingValue = undefined;
                    pending.resolve(m.value);
                }
                return;
            case "paused":
                this.onPaused(m);
                return;
            default:
                return; // success / resumed
        }
    }

    private onPaused(m: PausedMessage) {
        // the re-pause after a get-value at a breakpoint
        if (this.absorbPauses > 0) {
            this.absorbPauses--;
            return;
        }
        const stack = m.stack ?? [];
        const top: StackFrame | undefined = stack[0];
        const source = top?.source;
        if (this.spurious) {
            const s = this.spurious;
            this.spurious = undefined;
            if (m.reason === "breakpoint" && s.source === source && s.line === top?.line) {
                this.client?.send({ type: this.stepping ? "step-into-function" : "resume" });
                return;
            }
        }
        if (m.reason === "exception") {
            if (!this.stopOnError) {
                this.client?.send({ type: this.stepping ? "step-into-function" : "resume" });
                return;
            }
            this.stepping = undefined;
            return this.stop(m, "exception");
        }
        const s = this.stepping;
        if (!s) {
            // breakpoint (or a pause outside stepping)
            return this.stop(m, m.reason === "step" ? "step" : "breakpoint");
        }
        const keepStepping = () => {
            if (--s.budget <= 0) {
                this.stepping = undefined;
                this.output(`VoxelCore: stepping gave up after ${STEP_BUDGET} lines; continuing to the next breakpoint\n`, "console");
                this.client?.send({ type: "resume" });
                return;
            }
            this.client?.send({ type: "step-into-function" });
        };
        if (source && INTERNAL.test(source)) return keepStepping();
        if (m.reason === "breakpoint" && !(source === s.source && top?.line === s.line && stack.length === s.depth)) {
            // a user breakpoint on the way
            this.stepping = undefined;
            return this.stop(m, "breakpoint");
        }
        const depth = stack.length;
        const inEngine = !!source && ENGINE_CODE.test(source) && !s.engineOrigin;
        const sameLine = source === s.source && top?.line === s.line && depth === s.depth;
        switch (s.mode) {
            case "pause":
                this.stepping = undefined;
                return this.stop(m, "pause");
            case "in":
                if (sameLine) return keepStepping();
                if (inEngine) {
                    // stepped into or back to engine code: walk out of it, or leave
                    if (depth > s.depth) return keepStepping();
                    this.stepping = undefined;
                    this.client?.send({ type: "resume" });
                    return;
                }
                break;
            case "over":
                if (depth > s.depth || sameLine) return keepStepping();
                if (inEngine) {
                    // returned from the user's callback into the engine: like continue
                    this.stepping = undefined;
                    this.client?.send({ type: "resume" });
                    return;
                }
                break;
            case "out":
                if (depth >= s.depth) return keepStepping();
                if (inEngine) {
                    this.stepping = undefined;
                    this.client?.send({ type: "resume" });
                    return;
                }
                break;
        }
        this.stepping = undefined;
        this.stop(m, "step");
    }

    private stop(m: PausedMessage, reason: "breakpoint" | "exception" | "step" | "pause") {
        this.clearStop();
        this.paused = m;
        this.valuesAllowed = m.reason === "breakpoint";
        const body: Json = { reason, threadId: THREAD_ID, allThreadsStopped: true };
        if (reason === "exception") {
            body.description = "error()";
            body.text = m.message;
        }
        this.event("stopped", body);
    }

    // ---- inspection

    private stackTrace(req: DapRequest, args: Json) {
        const stack = this.paused?.stack ?? [];
        const start = Number(args.startFrame ?? 0);
        const count = Number(args.levels ?? 0) || stack.length;
        const frames = stack.slice(start, start + count).map((f, i) => {
            const index = start + i;
            const file = f.source ? this.host.toFile(f.source) : undefined;
            const engine = !!f.source && ENGINE_CODE.test(f.source);
            return {
                id: index + 1,
                name: f.function ?? (f.what === "main" ? "main chunk" : f.what === "C" ? "[C]" : "<anonymous>"),
                line: f.line ?? 0,
                column: 1,
                source: f.source
                    ? { name: file ? path.basename(file) : f.source, path: file, presentationHint: engine ? "deemphasize" : undefined, origin: f.source }
                    : undefined,
                presentationHint: f.what === "C" ? "subtle" : undefined,
            };
        });
        this.respond(req, { stackFrames: frames, totalFrames: stack.length });
    }

    private newHandle(handle: Handle): number {
        const id = this.nextHandle++;
        this.handles.set(id, handle);
        return id;
    }

    private display(type: string, short: string): string {
        return type === "string" ? JSON.stringify(short) : type === "table" && !this.valuesAllowed ? "{...} (expand at a breakpoint)" : short;
    }

    private async variables(req: DapRequest, args: Json) {
        const handle = this.handles.get(Number(args.variablesReference));
        if (!handle || !this.paused) {
            this.respond(req, { variables: [] });
            return;
        }
        if (handle.kind === "locals") {
            const frame = this.paused.stack?.[handle.frame];
            const variables = (frame?.locals ?? []).map((l) => ({
                name: l.name,
                value: this.display(l.type, l.short),
                type: l.type,
                variablesReference:
                    l.type === "table" && this.valuesAllowed
                        ? this.newHandle({ kind: "value", frame: handle.frame, local: l.index, path: [] })
                        : 0,
            }));
            this.respond(req, { variables });
            return;
        }
        const value = await this.getValue(handle.frame, handle.local, handle.path);
        if (!value || typeof value !== "object") {
            this.respond(req, { variables: [] });
            return;
        }
        const entries = Object.entries(value as Record<string, { type: string; short: string }>);
        entries.sort(([a], [b]) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b)));
        const variables = entries.map(([key, v]) => ({
            name: /^\d+$/.test(key) ? `[${key}]` : key,
            value: this.display(v.type, v.short),
            type: v.type,
            variablesReference:
                v.type === "table"
                    ? this.newHandle({ kind: "value", frame: handle.frame, local: handle.local, path: [...handle.path, /^\d+$/.test(key) ? Number(key) : key] })
                    : 0,
        }));
        this.respond(req, { variables });
    }

    /** One `get-value` at a time: the engine answers `resumed`, `value`, then pauses again. */
    private getValue(frame: number, local: number, valuePath: (string | number)[]): Promise<unknown> {
        const run = () =>
            new Promise<unknown>((resolve) => {
                if (!this.client || !this.paused || !this.valuesAllowed) return resolve(undefined);
                const timer = setTimeout(() => {
                    // no answer: don't swallow a later, real pause
                    this.pendingValue = undefined;
                    this.absorbPauses = Math.max(0, this.absorbPauses - 1);
                    resolve(undefined);
                }, 5000);
                this.absorbPauses++;
                this.pendingValue = {
                    resolve: (v) => {
                        clearTimeout(timer);
                        resolve(v);
                    },
                };
                this.client.send({ type: "get-value", frame, local, path: valuePath });
            });
        const result = this.valueQueue.then(run, run);
        this.valueQueue = result.catch(() => undefined);
        return result;
    }

    private async evaluate(req: DapRequest, args: Json) {
        const expression = String(args.expression ?? "").trim();
        const frameIndex = Number(args.frameId ?? 1) - 1;
        const m = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*|\[\d+\]|\["[^"]*"\])*)$/.exec(expression);
        const frame = this.paused?.stack?.[frameIndex];
        if (!m || !frame) {
            this.fail(req, "Only local variables and paths like a.b[1] can be evaluated (VC-DBG has no expression evaluation)");
            return;
        }
        const local = [...(frame.locals ?? [])].reverse().find((l) => l.name === m[1]);
        if (!local) {
            this.fail(req, `no local '${m[1]}' in this frame`);
            return;
        }
        const valuePath: (string | number)[] = [];
        for (const seg of m[2].matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]|\["([^"]*)"\]/g)) {
            valuePath.push(seg[1] ?? (seg[2] !== undefined ? Number(seg[2]) : seg[3]));
        }
        if (!valuePath.length) {
            this.respond(req, {
                result: this.display(local.type, local.short),
                type: local.type,
                variablesReference:
                    local.type === "table" && this.valuesAllowed ? this.newHandle({ kind: "value", frame: frameIndex, local: local.index, path: [] }) : 0,
            });
            return;
        }
        if (!this.valuesAllowed) {
            this.fail(req, "Table fields can be read only when stopped at a breakpoint (VC-DBG get-value resumes the program after a step)");
            return;
        }
        const value = await this.getValue(frameIndex, local.index, valuePath);
        if (value && typeof value === "object") {
            this.respond(req, {
                result: "{...}",
                type: "table",
                variablesReference: this.newHandle({ kind: "value", frame: frameIndex, local: local.index, path: valuePath }),
            });
        } else {
            this.respond(req, { result: value === undefined || value === null ? "nil" : typeof value === "string" ? JSON.stringify(value) : String(value), variablesReference: 0 });
        }
    }
}
