// Engine log → Output channel + Problems (FEATURES.md §4.3).
//
// Engines started by the `voxelcore` task feed their stdout here. Engines
// started elsewhere with the same user dir are followed through
// `<userDir>/latest.log`. Errors are mapped back to workspace files with the
// content index (shared/log) and shown in a separate diagnostic collection
// that is cleared when the next engine session starts.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { LogParser, type LogEntry } from "../../shared/log/parse";
import { LogContext, problemOf, type RuntimeProblem } from "../../shared/log/problems";
import { LogResolver, type FileLocation } from "../../shared/log/resolve";
import { findLogLinks } from "../../shared/log/links";
import { workspaceIndex } from "../workspaceIndex";

const FLUSH_DELAY = 150;
const TAIL_INTERVAL = 500;
const MAX_PROBLEMS = 500;
const HEAD_BYTES = 64;
const SOURCE = "VoxelCore engine";

export interface SessionOptions {
    userDir?: string;
    /** The `--script` app script, for `script:<name>` chunks. */
    script?: string;
    /** The `--project` folder, for `project:` chunks. */
    project?: string;
}

/** One engine run (a process or a latest.log generation). */
export interface EngineSession {
    feed(chunk: string): void;
    end(): void;
}

function liveText(file: string): string | undefined {
    const key = path.normalize(file).toLowerCase();
    return vscode.workspace.textDocuments
        .find((d) => d.uri.scheme === "file" && path.normalize(d.uri.fsPath).toLowerCase() === key)
        ?.getText();
}

function toRange(loc: FileLocation): vscode.Range {
    return new vscode.Range(loc.start.line, loc.start.character, loc.end.line, loc.end.character);
}

class RuntimeDiagnostics {
    private readonly collection = vscode.languages.createDiagnosticCollection("voxelcore-runtime");
    private readonly byFile = new Map<string, { diag: vscode.Diagnostic; base: string; count: number }[]>();
    private total = 0;

    clear() {
        this.collection.clear();
        this.byFile.clear();
        this.total = 0;
    }

    add(problem: RuntimeProblem, resolver: LogResolver): boolean {
        const loc = problem.target && resolver.resolve(problem.target);
        if (!loc) return false;
        const uri = vscode.Uri.file(loc.file);
        const list = this.byFile.get(uri.toString()) ?? [];
        const range = toRange(loc);
        const existing = list.find((d) => d.base === problem.message && d.diag.range.isEqual(range));
        if (existing) {
            // repeated errors (e.g. every tick) collapse into one with a counter
            existing.count++;
            existing.diag.message = `${problem.message} (×${existing.count})`;
        } else {
            if (this.total >= MAX_PROBLEMS) return true;
            this.total++;
            const diag = new vscode.Diagnostic(
                range,
                problem.message,
                problem.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
            );
            diag.source = SOURCE;
            const related: vscode.DiagnosticRelatedInformation[] = [];
            for (const frame of problem.frames.slice(0, 8)) {
                const f = resolver.resolve({ kind: "vpath", vpath: frame.vpath, line: frame.line });
                if (f) related.push(new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.file(f.file), toRange(f)), `${frame.vpath}:${frame.line}`));
            }
            if (related.length) diag.relatedInformation = related;
            list.push({ diag, base: problem.message, count: 1 });
            this.byFile.set(uri.toString(), list);
        }
        this.collection.set(uri, list.map((d) => d.diag));
        return true;
    }

    /** For tests: file → messages. */
    snapshot(): Record<string, string[]> {
        const result: Record<string, string[]> = {};
        for (const [uri, list] of this.byFile) result[vscode.Uri.parse(uri).fsPath] = list.map((d) => `${d.diag.range.start.line + 1}: ${d.diag.message}`);
        return result;
    }

    dispose() {
        this.collection.dispose();
    }
}

export class EngineLog implements vscode.Disposable {
    readonly channel = vscode.window.createOutputChannel("VoxelCore", { log: true });
    readonly diagnostics = new RuntimeDiagnostics();
    private ownSessions = 0;
    private readonly sessionsChanged = new vscode.EventEmitter<void>();
    /** An engine started by the extension started or exited. */
    readonly onDidChangeSessions = this.sessionsChanged.event;
    private tail: LogTail | undefined;
    private lastOptions: SessionOptions = {};

    /** Starts a session: clears runtime problems from the previous run. */
    startSession(options: SessionOptions, own = true): EngineSession {
        this.lastOptions = options;
        this.diagnostics.clear();
        if (own) {
            this.ownSessions++;
            this.sessionsChanged.fire();
        }
        const context = new LogContext();
        const resolver = () => new LogResolver(workspaceIndex.get(), { ...options, text: liveText });
        let problems = 0;
        const parser = new LogParser((entry) => {
            context.observe(entry);
            this.write(entry);
            const problem = problemOf(entry, context);
            if (problem && this.diagnostics.add(problem, resolver())) problems++;
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let ended = false;
        return {
            feed: (chunk) => {
                if (ended) return;
                parser.push(chunk);
                clearTimeout(timer);
                timer = setTimeout(() => parser.flush(), FLUSH_DELAY);
            },
            end: () => {
                if (ended) return;
                ended = true;
                clearTimeout(timer);
                parser.flush();
                if (own) {
                    this.ownSessions--;
                    this.sessionsChanged.fire();
                    // the process wrote latest.log too: don't replay it
                    this.tail?.skipToEnd();
                }
                if (problems > 0) this.channel.info(`[vscode] ${problems} engine problem(s) mapped to files; see the Problems panel`);
            },
        };
    }

    get ownSessionRunning(): boolean {
        return this.ownSessions > 0;
    }

    get runningEngines(): number {
        return this.ownSessions;
    }

    /** Follow `<userDir>/latest.log` for engines started outside VS Code. */
    watch(userDir: string | undefined) {
        this.tail?.dispose();
        this.tail = undefined;
        const enabled = vscode.workspace.getConfiguration("voxelcore").get<boolean>("log.tail", true);
        if (!userDir || !enabled) return;
        this.tail = new LogTail(path.join(userDir, "latest.log"), this, { userDir });
    }

    resolver(): LogResolver {
        return new LogResolver(workspaceIndex.get(), { ...this.lastOptions, text: liveText });
    }

    private write(entry: LogEntry) {
        const text = [entry.module ? `[${entry.module}] ${entry.message}` : entry.message, ...entry.details].join("\n");
        switch (entry.level) {
            case "debug":
                this.channel.debug(text);
                break;
            case "warning":
                this.channel.warn(text);
                break;
            case "error":
                this.channel.error(text);
                break;
            default:
                this.channel.info(text);
        }
    }

    dispose() {
        this.tail?.dispose();
        this.sessionsChanged.dispose();
        this.diagnostics.dispose();
        this.channel.dispose();
    }
}

/** Polls a log file; a shrinking file is a new engine session. */
class LogTail implements vscode.Disposable {
    private offset: number;
    /** The first bytes of the file: each engine start writes a new timestamp there. */
    private head: string;
    private session: EngineSession | undefined;
    private readonly listener = (curr: fs.Stats) => this.poll(curr.size);

    constructor(
        private readonly file: string,
        private readonly log: EngineLog,
        private readonly options: SessionOptions
    ) {
        this.offset = this.size();
        this.head = this.readHead();
        fs.watchFile(file, { interval: TAIL_INTERVAL }, this.listener);
    }

    private size(): number {
        try {
            return fs.statSync(this.file).size;
        } catch {
            return 0;
        }
    }

    private readHead(): string {
        try {
            const fd = fs.openSync(this.file, "r");
            try {
                const buffer = Buffer.alloc(HEAD_BYTES);
                const n = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
                return buffer.toString("utf8", 0, n);
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return "";
        }
    }

    skipToEnd() {
        this.offset = this.size();
        this.head = this.readHead();
    }

    private poll(size: number) {
        if (this.log.ownSessionRunning) {
            this.offset = size;
            return;
        }
        const head = this.readHead();
        const restarted = this.head.length >= HEAD_BYTES && !head.startsWith(this.head);
        this.head = head;
        if (size < this.offset || restarted || (size > 0 && this.offset === 0)) {
            // Logger::init truncates latest.log when an engine starts
            this.session?.end();
            this.session = this.log.startSession(this.options, false);
            this.log.channel.info(`[vscode] following ${this.file}`);
            this.offset = 0;
        }
        if (size <= this.offset) return;
        let text = "";
        try {
            const fd = fs.openSync(this.file, "r");
            try {
                const buffer = Buffer.alloc(size - this.offset);
                fs.readSync(fd, buffer, 0, buffer.length, this.offset);
                text = buffer.toString("utf8");
            } finally {
                fs.closeSync(fd);
            }
        } catch {
            return;
        }
        this.offset = size;
        if (!this.session) this.session = this.log.startSession(this.options, false);
        this.session.feed(text);
    }

    dispose() {
        fs.unwatchFile(this.file, this.listener);
        this.session?.end();
    }
}

/** Links for virtual paths in log text. */
function resolveLink(log: EngineLog, vpath: string, line?: number): vscode.Uri | undefined {
    const file = log.resolver().resolveVirtual(vpath);
    if (!file) return undefined;
    const uri = vscode.Uri.file(file);
    return line ? uri.with({ fragment: `L${line}` }) : uri;
}

interface VcTerminalLink extends vscode.TerminalLink {
    target: vscode.Uri;
}

export function registerLog(context: vscode.ExtensionContext): EngineLog {
    const log = new EngineLog();
    context.subscriptions.push(
        log,
        vscode.languages.registerDocumentLinkProvider([{ scheme: "output" }, { pattern: "**/latest.log" }], {
            provideDocumentLinks(doc) {
                // only our channel among the output documents
                if (doc.uri.scheme === "output" && !/VoxelCore/i.test(doc.uri.path)) return [];
                const links: vscode.DocumentLink[] = [];
                for (let i = 0; i < doc.lineCount; i++) {
                    for (const l of findLogLinks(doc.lineAt(i).text)) {
                        const target = resolveLink(log, l.vpath, l.line);
                        if (target) links.push(new vscode.DocumentLink(new vscode.Range(i, l.start, i, l.start + l.length), target));
                    }
                }
                return links;
            },
        }),
        vscode.window.registerTerminalLinkProvider({
            provideTerminalLinks(ctx): VcTerminalLink[] {
                const links: VcTerminalLink[] = [];
                for (const l of findLogLinks(ctx.line)) {
                    const target = resolveLink(log, l.vpath, l.line);
                    if (target) links.push({ startIndex: l.start, length: l.length, tooltip: "Open in editor", target });
                }
                return links;
            },
            async handleTerminalLink(link: VcTerminalLink) {
                const line = /^L(\d+)$/.exec(link.target.fragment);
                const pos = new vscode.Position(line ? Number(line[1]) - 1 : 0, 0);
                await vscode.window.showTextDocument(link.target.with({ fragment: "" }), { selection: new vscode.Range(pos, pos) });
            },
        }),
        vscode.commands.registerCommand("voxelcore.clearRuntimeProblems", () => log.diagnostics.clear()),
        vscode.commands.registerCommand("voxelcore.showEngineOutput", () => log.channel.show(true)),
        // internal, used by the smoke test
        vscode.commands.registerCommand("voxelcore.log.inspect", () => log.diagnostics.snapshot()),
        vscode.commands.registerCommand("voxelcore.log.feed", (text: string, options?: SessionOptions) => {
            const session = log.startSession(options ?? {}, false);
            session.feed(text);
            session.end();
            return log.diagnostics.snapshot();
        })
    );
    return log;
}
