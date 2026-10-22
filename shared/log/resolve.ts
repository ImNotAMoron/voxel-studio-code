// Resolves log problem targets to workspace files with the content index.
// Pure Node (fs), no `vscode` import.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseTree, findNodeAtLocation, type Node } from "jsonc-parser";
import type { ContentIndex, UnitDef } from "../content";
import type { ProblemTarget, UnitKindName } from "./problems";
import { CLIENT_SCRIPT } from "../content/project";

/** 0-based range in a file. */
export interface FileLocation {
    file: string;
    start: { line: number; character: number };
    end: { line: number; character: number };
}

export interface ResolveOptions {
    /** Engine user dir (`user:`). */
    userDir?: string;
    /** The `--script` app script (`script:<name>`). */
    script?: string;
    /** The `--project` folder (`project:<path>`; project_client.lua's chunk is its bare name). */
    project?: string;
    /** Live editor text by absolute path. */
    text?: (file: string) => string | undefined;
}

const ENTRY_POINTS = new Set(["user", "world", "project", "res"]);

function lineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    return starts;
}

function position(starts: number[], offset: number) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= offset) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo, character: offset - starts[lo] };
}

export class LogResolver {
    constructor(
        private readonly index: ContentIndex,
        private readonly options: ResolveOptions = {}
    ) {}

    private read(file: string): string | undefined {
        const live = this.options.text?.(file);
        if (live !== undefined) return live;
        try {
            return fs.readFileSync(file, "utf8");
        } catch {
            return undefined;
        }
    }

    /** `pack:path`, `user:content/<pack>/path`, `res:...`, `script:<name>` -> absolute path of an existing file. */
    /** The inverse of `resolveVirtual`: the chunk name the engine gives a pack file (`pack:scripts/x.lua`). */
    virtualPath(file: string): string | undefined {
        const key = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
        if (this.options.script && key(this.options.script) === key(file)) return `script:${path.basename(file)}`;
        const pack = this.index.packForFile(file);
        const project = this.options.project;
        if (project && (!pack || pack.id === "core") && key(file).startsWith(key(project) + path.sep)) {
            const rel = path.relative(project, file).split(path.sep).join("/");
            // scripting::load_client_project_script names the chunk by the file name only
            return rel === CLIENT_SCRIPT ? CLIENT_SCRIPT : `project:${rel}`;
        }
        if (!pack) return undefined;
        return `${pack.id}:${path.relative(pack.root, file).split(path.sep).join("/")}`;
    }

    resolveVirtual(vpath: string): string | undefined {
        if (vpath === CLIENT_SCRIPT && this.options.project) {
            const file = path.join(this.options.project, CLIENT_SCRIPT);
            return fs.existsSync(file) ? file : undefined;
        }
        const m = /^([\w-]+):(.*)$/.exec(vpath.replace(/\\/g, "/"));
        if (!m) return undefined;
        const [, ep, rel] = m;
        const candidates: string[] = [];
        const content = /^content\/([^/]+)\/(.*)$/.exec(rel);
        if (ENTRY_POINTS.has(ep) && content) {
            // packs are linked into <dir>/content, so map them back to the workspace
            const pack = this.index.packs.get(content[1]);
            if (pack) candidates.push(path.join(pack.root, content[2]));
        }
        if (ep === "res" || ep === "core") {
            if (this.index.resPath) candidates.push(path.join(this.index.resPath, rel));
        } else if (ep === "user") {
            if (this.options.userDir) candidates.push(path.join(this.options.userDir, rel));
        } else if (ep === "project") {
            if (this.options.project) candidates.push(path.join(this.options.project, rel));
        } else if (ep === "script") {
            if (this.options.script && path.basename(this.options.script) === rel) candidates.push(this.options.script);
        } else {
            const pack = this.index.packs.get(ep);
            if (pack) candidates.push(path.join(pack.root, rel));
        }
        return candidates.find((f) => {
            try {
                return fs.statSync(f).isFile();
            } catch {
                return false;
            }
        });
    }

    resolve(target: ProblemTarget): FileLocation | undefined {
        switch (target.kind) {
            case "vpath": {
                const file = this.resolveVirtual(target.vpath);
                if (!file) return undefined;
                return this.lineLocation(file, target.line, target.column);
            }
            case "unitValue": {
                const kinds: UnitKindName[] = target.unit ? [target.unit] : ["block", "item", "entity"];
                for (const kind of kinds) {
                    const unit = this.index.getUnit(kind, target.id);
                    if (!unit) continue;
                    for (const file of this.unitFiles(unit)) {
                        const loc = this.findValue(file, target.key, target.value);
                        if (loc) return loc;
                    }
                    if (unit.file) return this.lineLocation(unit.file);
                }
                return undefined;
            }
            case "packValue": {
                for (const file of this.packUnitFiles(target.pack, target.unit)) {
                    const loc = this.findValue(file, target.key, target.value);
                    if (loc) return loc;
                }
                return undefined;
            }
            case "unresolvedParents": {
                for (const file of this.packUnitFiles(target.pack, target.unit)) {
                    const text = this.read(file);
                    const tree = text === undefined ? undefined : parseTree(text);
                    const parent = tree && findNodeAtLocation(tree, ["parent"]);
                    if (parent?.type === "string" && !this.index.getUnit(target.unit, String(parent.value))) {
                        return this.nodeLocation(file, text!, parent);
                    }
                }
                return undefined;
            }
            case "resourceKey": {
                const root = this.index.packs.get(target.pack)?.root;
                if (!root) return undefined;
                const file = path.join(root, "resources.json");
                const text = this.read(file);
                const tree = text === undefined ? undefined : parseTree(text);
                const prop = tree?.children?.find((c) => c.children?.[0]?.value === target.key)?.children?.[0];
                return prop ? this.nodeLocation(file, text!, prop) : undefined;
            }
            case "model": {
                const file = this.index.resolveModel(target.name, target.pack);
                return file ? this.lineLocation(file) : undefined;
            }
        }
    }

    private unitFiles(unit: UnitDef): string[] {
        return [unit.file, ...unit.overrides.map((o) => o.file)].filter((f): f is string => !!f);
    }

    private packUnitFiles(pack: string, kind: UnitKindName): string[] {
        const pd = this.index.getPackData(pack);
        if (!pd) return [];
        return [...(kind === "block" ? pd.blocks : kind === "item" ? pd.items : pd.entities).values()];
    }

    /** The value of top-level `key` (a string equal to `value`, or an array containing it). */
    private findValue(file: string, key: string, value?: string): FileLocation | undefined {
        const text = this.read(file);
        if (text === undefined) return undefined;
        const tree = parseTree(text);
        const node = tree && findNodeAtLocation(tree, [key]);
        if (!node) return undefined;
        if (value === undefined) return this.nodeLocation(file, text, node);
        if (node.type === "string" && node.value === value) return this.nodeLocation(file, text, node);
        if (node.type === "array") {
            const item = node.children?.find((c) => c.type === "string" && c.value === value);
            if (item) return this.nodeLocation(file, text, item);
        }
        return undefined;
    }

    private nodeLocation(file: string, text: string, node: Node): FileLocation {
        const starts = lineStarts(text);
        return { file, start: position(starts, node.offset), end: position(starts, node.offset + node.length) };
    }

    /** A 1-based line (and column) or the first line; the range covers the rest of the line. */
    private lineLocation(file: string, line?: number, column?: number): FileLocation {
        const text = this.read(file) ?? "";
        const lines = text.split(/\r?\n/);
        const l = Math.min(Math.max((line ?? 1) - 1, 0), Math.max(lines.length - 1, 0));
        const content = lines[l] ?? "";
        const indent = content.length - content.trimStart().length;
        const startChar = column ? Math.min(column - 1, content.length) : indent;
        return {
            file,
            start: { line: l, character: startChar },
            end: { line: l, character: Math.max(content.length, startChar + 1) },
        };
    }
}
