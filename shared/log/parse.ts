// Engine log parsing. Pure, no `vscode` import.
//
// Line format (src/debug/Logger.cpp `write`):
//   [E] 2026/10/22 10:44:22.655+0300 [block-content-loader] unknown model: cubee
// The module name is right-aligned to 20 characters. Messages may span lines:
// Lua tracebacks continue with "stack traceback:" and tab-indented frames,
// parsing errors with an indented source excerpt. LogLevel::print writes
// `[module]    message` without level or time; `print()` from Lua and other
// stdout output has no header at all.

export type LogLevel = "debug" | "info" | "warning" | "error" | "print";

export interface LogEntry {
    level: LogLevel;
    /** `2026/10/22 10:44:22.655+0300`; absent for print/plain output. */
    time?: string;
    module: string;
    /** First line of the message. */
    message: string;
    /** Continuation lines (traceback, excerpt), without the trailing newline. */
    details: string[];
}

const HEADER = /^\[([DIWE])\] (\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\.\d{3}(?:[+-]\d{4})?) \[\s*([^\]]*)\] ?(.*)$/;
const PRINT = /^\[([^\]\s][^\]]*)\] {4}(.*)$/;
const LEVELS: Record<string, LogLevel> = { D: "debug", I: "info", W: "warning", E: "error" };

/** A line that belongs to the previous entry. */
function isContinuation(line: string): boolean {
    return /^\s/.test(line) || line === "stack traceback:";
}

export function parseHeader(line: string): LogEntry | undefined {
    const m = HEADER.exec(line);
    if (m) return { level: LEVELS[m[1]], time: m[2], module: m[3].trim(), message: m[4], details: [] };
    const p = PRINT.exec(line);
    if (p) return { level: "print", module: p[1], message: p[2], details: [] };
    return undefined;
}

/**
 * Streaming parser: feed stdout chunks or log file appends with `push`. An
 * entry is emitted once the next entry starts or on `flush` (call it on a
 * short timer and when the stream ends; a traceback may still be arriving).
 */
export class LogParser {
    private partial = "";
    private current: LogEntry | undefined;

    constructor(private readonly onEntry: (entry: LogEntry) => void) {}

    push(chunk: string) {
        const text = this.partial + chunk;
        const lines = text.split(/\r?\n/);
        this.partial = lines.pop() ?? "";
        for (const line of lines) this.line(line);
    }

    /** Emits the pending entry (and a trailing line without a newline). */
    flush() {
        if (this.partial) {
            this.line(this.partial);
            this.partial = "";
        }
        if (this.current) {
            const entry = this.current;
            this.current = undefined;
            this.onEntry(entry);
        }
    }

    private line(line: string) {
        const header = parseHeader(line);
        if (!header && this.current && isContinuation(line)) {
            this.current.details.push(line);
            return;
        }
        if (this.current) this.onEntry(this.current);
        this.current = header ?? { level: "print", module: "", message: line, details: [] };
    }
}

/** Parses a whole log (e.g. latest.log). */
export function parseLog(text: string): LogEntry[] {
    const entries: LogEntry[] = [];
    const parser = new LogParser((e) => entries.push(e));
    parser.push(text);
    parser.flush();
    return entries;
}
