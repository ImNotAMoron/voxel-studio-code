// Lua parsing helpers on top of luaparse (LuaJIT dialect).

import * as path from "node:path";
import { parse as luaParse } from "luaparse";
import { ContentIndex, PackInfo } from "../../../shared/content/index";
import { ScriptKind } from "./spec";

// luaparse's typings are partial; use a loose node shape.
export interface LuaNode {
    type: string;
    range?: [number, number];
    [key: string]: unknown;
}

export interface LuaParseResult {
    chunk?: LuaNode;
    error?: { message: string; index: number };
}

export function parseLua(text: string): LuaParseResult {
    try {
        const chunk = luaParse(text, {
            luaVersion: "LuaJIT",
            ranges: true,
            locations: false,
            scope: true,
            comments: false,
        } as never) as unknown as LuaNode;
        return { chunk };
    } catch (err) {
        const e = err as { message?: string; index?: number };
        return { error: { message: String(e.message ?? err).replace(/^\[\d+:\d+\]\s*/, ""), index: e.index ?? 0 } };
    }
}

/** Depth-first walk over every AST node. */
export function walkLua(node: unknown, visit: (node: LuaNode, parent: LuaNode | undefined, key: string) => void, parent?: LuaNode, key = "") {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const child of node) walkLua(child, visit, parent, key);
        return;
    }
    const n = node as LuaNode;
    if (typeof n.type !== "string") return;
    visit(n, parent, key);
    for (const [k, v] of Object.entries(n)) {
        if (k === "range" || k === "loc" || k === "globals") continue;
        if (v && typeof v === "object") walkLua(v, visit, n, k);
    }
}

/** Decodes a Lua string literal's raw text. */
export function unquoteLua(raw: string): string | undefined {
    if (raw.startsWith("[")) {
        const m = /^\[(=*)\[\n?([\s\S]*)\]\1\]$/.exec(raw);
        return m ? m[2] : undefined;
    }
    const q = raw[0];
    if ((q !== '"' && q !== "'") || raw[raw.length - 1] !== q) return undefined;
    const body = raw.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== "\\") {
            out += c;
            continue;
        }
        const e = body[++i];
        switch (e) {
            case "n": out += "\n"; break;
            case "t": out += "\t"; break;
            case "r": out += "\r"; break;
            case "\\": out += "\\"; break;
            case '"': out += '"'; break;
            case "'": out += "'"; break;
            default: out += e ?? "";
        }
    }
    return out;
}

export interface GlobalFunction {
    name: string;
    start: number;
    end: number;
    params: string[];
}

/** Top-level `function name()` / `name = function()` definitions of globals. */
export function topLevelGlobalFunctions(chunk: LuaNode): GlobalFunction[] {
    const result: GlobalFunction[] = [];
    for (const stmt of (chunk.body as LuaNode[]) ?? []) {
        if (stmt.type === "FunctionDeclaration") {
            const id = stmt.identifier as LuaNode | null;
            if (id && id.type === "Identifier" && !stmt.isLocal && !id.isLocal && id.range) {
                result.push({ name: id.name as string, start: id.range[0], end: id.range[1], params: paramNames(stmt) });
            }
        } else if (stmt.type === "AssignmentStatement") {
            const vars = stmt.variables as LuaNode[];
            const inits = stmt.init as LuaNode[];
            vars.forEach((v, i) => {
                if (v.type === "Identifier" && !v.isLocal && inits[i]?.type === "FunctionDeclaration" && v.range) {
                    result.push({ name: v.name as string, start: v.range[0], end: v.range[1], params: paramNames(inits[i]) });
                }
            });
        }
    }
    return result;
}

function paramNames(fn: LuaNode): string[] {
    return ((fn.parameters as LuaNode[]) ?? []).map((p) => (p.type === "Identifier" ? (p.name as string) : "..."));
}

/** Names of globals assigned anywhere in the chunk. */
export function assignedGlobals(chunk: LuaNode): Set<string> {
    const names = new Set<string>();
    walkLua(chunk, (node) => {
        if (node.type === "AssignmentStatement") {
            for (const v of node.variables as LuaNode[]) {
                if (v.type === "Identifier" && !v.isLocal) names.add(v.name as string);
            }
        } else if (node.type === "FunctionDeclaration") {
            const id = node.identifier as LuaNode | null;
            if (id?.type === "Identifier" && !id.isLocal && !node.isLocal) names.add(id.name as string);
        }
    });
    return names;
}

export interface IdentifierUse {
    name: string;
    start: number;
    end: number;
    isLocal: boolean;
}

/**
 * Identifier uses (reads), excluding member property names, definitions of
 * global functions and assignment targets.
 */
export function identifierUses(chunk: LuaNode): IdentifierUse[] {
    const uses: IdentifierUse[] = [];
    const defs = new Set<LuaNode>();
    walkLua(chunk, (node) => {
        if (node.type === "FunctionDeclaration" && node.identifier) defs.add(node.identifier as LuaNode);
        if (node.type === "AssignmentStatement" || node.type === "LocalStatement") {
            for (const v of node.variables as LuaNode[]) if (v.type === "Identifier") defs.add(v);
        }
        if (node.type === "FunctionDeclaration") {
            for (const p of (node.parameters as LuaNode[]) ?? []) defs.add(p);
        }
        if (node.type === "ForNumericStatement") defs.add(node.variable as LuaNode);
        if (node.type === "ForGenericStatement") for (const v of node.variables as LuaNode[]) defs.add(v);
    });
    walkLua(chunk, (node, parent, key) => {
        if (node.type !== "Identifier" || !node.range) return;
        if (defs.has(node)) return;
        if (parent && (parent.type === "MemberExpression") && key === "identifier") return;
        if (parent && parent.type === "TableKeyString" && key === "key") return;
        uses.push({ name: node.name as string, start: node.range[0], end: node.range[1], isLocal: !!node.isLocal });
    });
    return uses;
}

export interface StringCall {
    /** Callee text: `require`, `block.index`… */
    callee: string;
    value: string;
    start: number;
    end: number;
}

function calleeName(node: LuaNode): string | undefined {
    if (node.type === "Identifier") return node.isLocal ? undefined : (node.name as string);
    if (node.type === "MemberExpression" && node.indexer === ".") {
        const base = calleeName(node.base as LuaNode);
        const id = node.identifier as LuaNode;
        return base ? `${base}.${id.name as string}` : undefined;
    }
    return undefined;
}

/** Calls whose first argument is a string literal: `require "x"`, `block.index("x")`. */
export function stringCalls(chunk: LuaNode): StringCall[] {
    const result: StringCall[] = [];
    walkLua(chunk, (node) => {
        let arg: LuaNode | undefined;
        if (node.type === "CallExpression") arg = (node.arguments as LuaNode[])[0];
        else if (node.type === "StringCallExpression") arg = node.argument as LuaNode;
        else return;
        if (!arg || arg.type !== "StringLiteral" || !arg.range) return;
        const callee = calleeName(node.base as LuaNode);
        if (!callee) return;
        const value = unquoteLua(arg.raw as string);
        if (value === undefined) return;
        result.push({ callee, value, start: arg.range[0], end: arg.range[1] });
    });
    return result;
}

export interface GlobalCall {
    name: string;
    start: number;
    end: number;
}

/** Calls of global functions by plain name. */
export function globalCalls(chunk: LuaNode): GlobalCall[] {
    const result: GlobalCall[] = [];
    walkLua(chunk, (node) => {
        if (node.type !== "CallExpression" && node.type !== "StringCallExpression" && node.type !== "TableCallExpression") return;
        const base = node.base as LuaNode;
        if (base.type === "Identifier" && !base.isLocal && base.range) {
            result.push({ name: base.name as string, start: base.range[0], end: base.range[1] });
        }
    });
    return result;
}

export interface ScriptRole {
    kind: ScriptKind;
    /** Units using a `scripts/<name>.lua` unit script. */
    users?: string[];
    /** Script name relative to scripts/ (unit scripts). */
    scriptName?: string;
}

/** Determines the script kind from its location in the pack (see FEATURES.md §3.2). */
export function scriptRole(index: ContentIndex, pack: PackInfo | undefined, file: string): ScriptRole {
    const projectFile = index.projectFile(file);
    if (projectFile?.kind === "start") return { kind: "app" };
    if (projectFile?.kind === "client") return { kind: "project" };
    if (!pack) return { kind: "other" };
    const rel = path.relative(pack.root, file).split(path.sep).join("/");
    if (rel === "scripts/world.lua") return { kind: "world" };
    if (rel === "scripts/hud.lua") return { kind: "hud" };
    if (rel === "scripts/content.lua") return { kind: "content" };
    if (/^scripts\/components\/[^/]+\.lua$/.test(rel)) return { kind: "component" };
    if (/^layouts\/.+\.xml\.lua$/.test(rel)) return { kind: "layout" };
    if (/^generators\/[^/]+\.files\/script\.lua$/.test(rel)) return { kind: "generator" };
    if (rel.startsWith("modules/") && rel.endsWith(".lua")) return { kind: "module" };
    const m = /^scripts\/(.+)\.lua$/.exec(rel);
    if (m && !rel.startsWith("scripts/loaders/")) {
        const name = m[1];
        const users = index.scriptUsers(pack.id, name);
        const hasBlock = users.some((u) => u.kind === "block");
        const hasItem = users.some((u) => u.kind === "item");
        const kind: ScriptKind = hasBlock && hasItem ? "unit" : hasBlock ? "block" : hasItem ? "item" : name.includes("/") ? "other" : "unit";
        return { kind, users: users.map((u) => u.id), scriptName: name };
    }
    return { kind: "other" };
}

export interface NamedCall {
    /** Callee text: `network.get`, `app.start_debug_instance`… */
    callee: string;
    start: number;
    end: number;
    /** First argument when it's a string literal. */
    firstString?: string;
}

/** Calls through a global name or a chain of `.` fields (`a.b.c(...)`). */
export function namedCalls(chunk: LuaNode): NamedCall[] {
    const result: NamedCall[] = [];
    walkLua(chunk, (node) => {
        let arg: LuaNode | undefined;
        if (node.type === "CallExpression") arg = (node.arguments as LuaNode[])[0];
        else if (node.type === "StringCallExpression") arg = node.argument as LuaNode;
        else if (node.type !== "TableCallExpression") return;
        const base = node.base as LuaNode;
        const callee = calleeName(base);
        if (!callee || !base.range) return;
        const firstString = arg?.type === "StringLiteral" ? unquoteLua(arg.raw as string) : undefined;
        result.push({ callee, start: base.range[0], end: base.range[1], firstString });
    });
    return result;
}
