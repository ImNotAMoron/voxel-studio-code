// Maps engine log entries to problems with "targets" (where the problem is in
// the pack). Pure: targets are resolved to files by ./resolve.ts.
//
// Patterns are taken from the engine (v0.32) and checked against real logs:
// - Lua errors: chunks are named `[string "pack:scripts/x.lua"]:LINE`
//   (lua::loadbuffer); event handler errors are prefixed with
//   `error in event (<name>) handler: ` (res/modules/internal/events.lua).
//   `error()` is wrapped by res/modules/internal/debugging.lua, so the first
//   location is often the wrapper: the first frame outside core is used.
// - `file "<vpath>": <msg>`: ContentUnitLoader::loadUnit (ContentLoader.cpp)
// - `parsing error in file '<vpath>' at L:C: <msg>`: parsing_error::errorLog
// - BlockLoader.cpp / ItemLoader.cpp enum errors, logged without a file name
//   but after `loading pack [<id>]` (content-loader).
// - `component X is not available (required by entity Y)`: ContentBuilder
// - `Failed to find parent(P) for N` / `Unresolved <dir> dependencies detected.`
// - `unknown resource type: K` (ContentLoader::loadResources)
// - `error on loading model NAME: msg` (assetload_funcs.cpp)

import type { LogEntry } from "./parse";

export type UnitKindName = "block" | "item" | "entity";

export type ProblemTarget =
    /** A virtual path (`pack:path`, `user:content/pack/...`), 1-based line/column. */
    | { kind: "vpath"; vpath: string; line?: number; column?: number }
    /** A JSON property value in a unit definition. */
    | { kind: "unitValue"; unit: UnitKindName | undefined; id: string; key: string; value?: string }
    /** Some definition of `unit` kind in `pack` has `key` = `value`. */
    | { kind: "packValue"; pack: string; unit: UnitKindName; key: string; value: string }
    /** Units of `pack` whose `parent` can't be resolved. */
    | { kind: "unresolvedParents"; pack: string; unit: UnitKindName }
    /** A key in the pack's resources.json. */
    | { kind: "resourceKey"; pack: string; key: string }
    /** A model asset by name. */
    | { kind: "model"; name: string; pack?: string };

export interface RuntimeProblem {
    severity: "error" | "warning";
    message: string;
    target?: ProblemTarget;
    /** Lua traceback frames outside core, for related information. */
    frames: { vpath: string; line: number }[];
    /** The whole entry text, for the hover/tooltip. */
    raw: string;
}

const LUA_LOCATION = /\[string "([^"]+)"\]:(\d+)/g;
const INTERNAL_CHUNK = /^(core|res):/;

/** Keeps the state needed to interpret entries that don't name a file. */
export class LogContext {
    /** Pack being loaded (`loading pack [id]`). */
    pack: string | undefined;

    observe(entry: LogEntry) {
        if (entry.module === "content-loader") {
            const m = /^loading pack \[([^\]]+)\]$/.exec(entry.message);
            if (m) this.pack = m[1];
        }
    }
}

function luaFrames(text: string): { vpath: string; line: number }[] {
    const frames: { vpath: string; line: number }[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(LUA_LOCATION)) {
        if (INTERNAL_CHUNK.test(m[1])) continue;
        const key = `${m[1]}:${m[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        frames.push({ vpath: m[1], line: Number(m[2]) });
    }
    return frames;
}

/** Strips handler prefixes and leading Lua locations from an error line. */
export function cleanMessage(message: string): string {
    let text = message.replace(/^error in event \([^)]*\) handler: /, "");
    for (;;) {
        const m = /^\[string "[^"]+"\]:\d+: /.exec(text);
        if (!m) break;
        text = text.slice(m[0].length);
    }
    return text;
}

function specificTarget(message: string, module: string, ctx: LogContext): { target: ProblemTarget; message: string } | undefined {
    let m: RegExpExecArray | null;
    if ((m = /^(?:parsing error: )?parsing error in file '([^']+)' at (\d+):(\d+): (.*)$/.exec(message))) {
        // parsing_error::errorLog prints `line + 1` of an already 1-based line, and a 0-based column
        return { target: { kind: "vpath", vpath: m[1], line: Math.max(Number(m[2]) - 1, 1), column: Number(m[3]) + 1 }, message: m[4] };
    }
    if ((m = /^file "([^"]+)": (.*)$/.exec(message))) {
        const nested = specificTarget(m[2], module, ctx);
        if (nested?.target.kind === "vpath" && nested.target.line) return nested;
        return { target: { kind: "vpath", vpath: m[1] }, message: m[2] };
    }
    if ((m = /^component (\S+) is not available \(required by entity (\S+)\)/.exec(message))) {
        return { target: { kind: "unitValue", unit: "entity", id: m[2], key: "components", value: m[1] }, message };
    }
    if ((m = /^Failed to find parent\((.+)\) for (\S+)/.exec(message))) {
        return { target: { kind: "unitValue", unit: undefined, id: m[2], key: "parent", value: m[1] }, message };
    }
    if ((m = /^Unresolved (blocks|items|entities) dependencies detected\./.exec(message)) && ctx.pack) {
        const unit = m[1] === "blocks" ? "block" : m[1] === "items" ? "item" : "entity";
        return { target: { kind: "unresolvedParents", pack: ctx.pack, unit }, message: `${message.replace(/:$/, "")} (a 'parent' that isn't loaded yet)` };
    }
    if ((m = /^error on loading model (\S+): (.*)$/.exec(message))) {
        return { target: { kind: "model", name: m[1] }, message: m[2] };
    }
    if (module === "block-content-loader" && ctx.pack) {
        const enums: [RegExp, string][] = [
            [/^unknown model: (.*)$/, "model"],
            [/^unknown culling mode: (.*)$/, "culling"],
            [/^unknown rotation profile (.*)$/, "rotation"],
            [/^unknown grounding behaviour: (.*)$/, "grounding-behaviour"],
        ];
        for (const [re, key] of enums) {
            const e = re.exec(message);
            if (e) return { target: { kind: "packValue", pack: ctx.pack, unit: "block", key, value: e[1] }, message };
        }
    }
    if ((m = /^(\S+): unknown icon type - (.*)$/.exec(message))) {
        return { target: { kind: "unitValue", unit: "item", id: m[1], key: "icon-type", value: m[2] }, message };
    }
    if ((m = /^(\S+): unknown uses display mode - (.*)$/.exec(message))) {
        return { target: { kind: "unitValue", unit: "item", id: m[1], key: "uses-display", value: m[2] }, message };
    }
    if ((m = /^unknown resource type: (.*)$/.exec(message)) && ctx.pack) {
        return { target: { kind: "resourceKey", pack: ctx.pack, key: m[1] }, message };
    }
    // asset loaders: `<vpath>: <msg>` (assetload_funcs.cpp, alutil.cpp)
    if ((m = /^([a-z_][\w-]*:[^\s"':]+\.\w+): (.*)$/i.exec(message))) {
        return { target: { kind: "vpath", vpath: m[1] }, message: m[2] };
    }
    return undefined;
}

/**
 * The problem an entry describes, if any. Only warnings and errors count.
 * Call `ctx.observe(entry)` for every entry first, in order.
 */
export function problemOf(entry: LogEntry, ctx: LogContext): RuntimeProblem | undefined {
    if (entry.level !== "error" && entry.level !== "warning") return undefined;
    const raw = [entry.message, ...entry.details].join("\n");
    const frames = luaFrames(raw);
    // the cause is the innermost message; tracebacks end it with ":"
    let message = cleanMessage(entry.message);
    if (entry.details.length > 0) message = message.replace(/:$/, "");
    const severity = entry.level;
    const specific = specificTarget(message, entry.module, ctx);
    if (specific) {
        return { severity, message: specific.message, target: specific.target, frames, raw };
    }
    // nested errors are prefixed with every location they passed through; the
    // innermost (last) one outside core is the error site, e.g. a syntax error
    // in a block script reported through the app script's new_world call
    const prefixes = messageLocations(entry.message).filter((l) => !INTERNAL_CHUNK.test(l.vpath));
    const primary = prefixes[prefixes.length - 1] ?? frames[0];
    return {
        severity,
        message,
        target: primary ? { kind: "vpath", vpath: primary.vpath, line: primary.line } : undefined,
        frames: frames.filter((f) => !primary || f.vpath !== primary.vpath || f.line !== primary.line),
        raw,
    };
}

/** The `[string "x"]:N: ` prefixes at the start of an error line, outermost first. */
function messageLocations(message: string): { vpath: string; line: number }[] {
    const result: { vpath: string; line: number }[] = [];
    let text = message.replace(/^error in event \([^)]*\) handler: /, "");
    for (;;) {
        const m = /^\[string "([^"]+)"\]:(\d+): /.exec(text);
        if (!m) break;
        result.push({ vpath: m[1], line: Number(m[2]) });
        text = text.slice(m[0].length);
    }
    return result;
}
