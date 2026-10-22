// Lua inside layout callback attributes and the layout's `<name>.xml.lua`
// script (FEATURES.md §3.7). The engine compiles a chunk attribute as is
// (scripting::create_runnable → loadbuffer) and an expression attribute as
// `"return " + value` (lua::eval), in the document's environment, where the
// script's globals live (UiDocument::read, create_doc_environment).

import * as fs from "node:fs";
import * as path from "node:path";
import { CompletionItem, CompletionItemKind, InsertTextFormat, Range, TextEdit } from "vscode-languageserver/node";
import { layoutAttribute, type LuaCallback } from "../../../shared/layouts";
import { parseLayoutXml, walkElements, type XmlAttribute } from "../../../shared/layouts/xml";
import { GlobalFunction, assignedGlobals, identifierUses, parseLua, topLevelGlobalFunctions } from "../lua/analyze";

export interface CallbackName {
    name: string;
    start: number;
    end: number;
}

export interface CallbackLua {
    /** The compiled source, as the engine builds it. */
    source: string;
    /** Global names the code reads, with offsets in the layout file. */
    globals: CallbackName[];
    error?: { message: string; start: number; end: number };
}

/** Parses an attribute's Lua; offsets are exact when the raw value has no escapes or entities. */
export function callbackLua(text: string, attr: XmlAttribute, lua: LuaCallback): CallbackLua | undefined {
    if (!attr.valueSpan || attr.value.includes("%{")) return undefined;
    const prefix = lua.kind === "expression" ? "return " : "";
    const source = prefix + attr.value;
    const exact = text.slice(attr.valueSpan.start, attr.valueSpan.end) === attr.value;
    const at = (offset: number) => {
        if (!exact) return attr.valueSpan!.start;
        return attr.valueSpan!.start + Math.min(Math.max(offset - prefix.length, 0), attr.value.length);
    };
    const parsed = parseLua(source);
    if (!parsed.chunk) {
        // an error at the end (`'a' ..`) marks the last character
        const span = attr.valueSpan;
        const start = exact ? Math.max(span.start, Math.min(at(parsed.error!.index), span.end - 1)) : span.start;
        return { source, globals: [], error: { message: parsed.error!.message, start, end: exact ? Math.min(start + 1, span.end) : span.end } };
    }
    const globals = identifierUses(parsed.chunk)
        .filter((u) => !u.isLocal)
        .map((u) => (exact ? { name: u.name, start: at(u.start), end: at(u.end) } : { name: u.name, start: attr.valueSpan!.start, end: attr.valueSpan!.end }));
    return { source, globals };
}

export interface LayoutScript {
    file: string;
    text: string;
    /** Top-level `function name()` / `name = function()`. */
    functions: GlobalFunction[];
    /** Every global the script assigns. */
    globals: Set<string>;
}

const scriptCache = new Map<string, { mtime: number; script: LayoutScript }>();

/** The layout's `.xml.lua`, if it exists (`getText` lets the server pass open documents). */
export function layoutScript(layoutFile: string, getText?: (file: string) => string | undefined): LayoutScript | undefined {
    const file = layoutFile + ".lua";
    const open = getText?.(file);
    let mtime = -1;
    if (open === undefined) {
        try {
            mtime = fs.statSync(file).mtimeMs;
        } catch {
            return undefined;
        }
        const cached = scriptCache.get(file);
        if (cached && cached.mtime === mtime) return cached.script;
    }
    let text = open;
    if (text === undefined) {
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            return undefined;
        }
    }
    const { chunk } = parseLua(text);
    const script: LayoutScript = { file, text, functions: chunk ? topLevelGlobalFunctions(chunk) : [], globals: chunk ? assignedGlobals(chunk) : new Set() };
    if (open === undefined) scriptCache.set(file, { mtime, script });
    return script;
}

const packCache = new Map<string, { stamp: string; names: Set<string> }>();

/**
 * Globals assigned anywhere in a pack's Lua (scripts, modules, layouts). A
 * name defined only there might reach the document another way (`_G.x = …`),
 * so it isn't reported as undefined.
 */
export function packGlobals(packRoot: string): Set<string> {
    const files: { file: string; mtime: number }[] = [];
    const walk = (dir: string, depth: number) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (depth < 8 && !e.name.startsWith(".") && e.name !== "node_modules") walk(p, depth + 1);
            } else if (e.name.endsWith(".lua")) {
                try {
                    files.push({ file: p, mtime: fs.statSync(p).mtimeMs });
                } catch {
                    // vanished
                }
            }
        }
    };
    walk(packRoot, 0);
    const stamp = files.map((f) => `${f.file}@${f.mtime}`).join("|");
    const cached = packCache.get(packRoot);
    if (cached && cached.stamp === stamp) return cached.names;
    const names = new Set<string>();
    for (const { file } of files) {
        try {
            const { chunk } = parseLua(fs.readFileSync(file, "utf8"));
            if (chunk) for (const n of assignedGlobals(chunk)) names.add(n);
        } catch {
            // unreadable
        }
    }
    packCache.set(packRoot, { stamp, names });
    return names;
}

/** `onclick="refresh()"` → `function refresh` in the layout's `.xml.lua`, as offsets in that file. */
export function layoutDefinition(text: string, layoutFile: string, offset: number): { file: string; start: number; end: number } | undefined {
    const doc = parseLayoutXml(text);
    for (const { element } of walkElements(doc.root)) {
        if (offset < element.span.start || offset > element.span.end) continue;
        for (const a of element.attributes) {
            if (!a.valueSpan || offset < a.valueSpan.start || offset > a.valueSpan.end) continue;
            const lua = layoutAttribute(element.tag, a.name)?.lua;
            if (!lua) return undefined;
            const name = callbackLua(text, a, lua)?.globals.find((g) => offset >= g.start && offset <= g.end && g.end > g.start);
            if (!name) return undefined;
            const fn = layoutScript(layoutFile)?.functions.find((f) => f.name === name.name);
            return fn && { file: layoutFile + ".lua", start: fn.start, end: fn.end };
        }
    }
    return undefined;
}

// ---------------------------------------------------------------- completion

/** Parameter names for an expression's function stub, by what the engine passes. */
function stubParams(attribute: string, lua: LuaCallback): string[] {
    const args = lua.args ?? [];
    if (args.length === 2 && args.every((a) => a === "integer")) return ["invid", "slot"]; // read_slot_func
    if (attribute === "oncontrolkey") return ["keycode"];
    return args.map((a, i) => (a === "string" ? "text" : a === "boolean" ? "checked" : args.length > 1 ? `v${i + 1}` : "value"));
}

/**
 * Completion inside a callback attribute's value: the layout script's
 * functions first (`name(…)` in chunks, `name` in expressions), a
 * `function(…) end` stub for expressions, then the engine's globals.
 */
export function callbackCompletions(
    text: string,
    layoutFile: string,
    offset: number,
    attribute: string,
    lua: LuaCallback,
    valueStart: number,
    engineNames: Iterable<string>,
    range: (start: number, end: number) => Range,
): CompletionItem[] {
    let start = offset;
    while (start > valueStart && /\w/.test(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && /\w/.test(text[end])) end++;
    // `a.b|` / `a:b|` is a member: not a global name
    let before = start;
    while (before > valueStart && /[ \t]/.test(text[before - 1])) before--;
    if (/[.:]/.test(text[before - 1] ?? "")) return [];
    const r = range(start, end);
    const items: CompletionItem[] = [];
    const script = layoutScript(layoutFile);
    const scriptName = path.basename(layoutFile) + ".lua";
    const seen = new Set<string>();
    for (const fn of script?.functions ?? []) {
        if (seen.has(fn.name)) continue;
        seen.add(fn.name);
        const line = script!.text.slice(0, fn.start).split("\n").length;
        const call = fn.params.length ? `${fn.name}(${fn.params.map((p, i) => `\${${i + 1}:${p}}`).join(", ")})` : `${fn.name}()`;
        items.push({
            label: fn.name,
            kind: CompletionItemKind.Function,
            detail: `function ${fn.name}(${fn.params.join(", ")}) — ${scriptName}:${line}`,
            sortText: `0${fn.name}`,
            textEdit: TextEdit.replace(r, lua.kind === "chunk" ? call : fn.name),
            insertTextFormat: lua.kind === "chunk" ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
        });
    }
    for (const name of script?.globals ?? []) {
        if (seen.has(name)) continue;
        seen.add(name);
        items.push({ label: name, kind: CompletionItemKind.Variable, detail: `global of ${scriptName}`, sortText: `1${name}`, textEdit: TextEdit.replace(r, name) });
    }
    // an expression is often an inline function
    if (lua.kind === "expression" && !text.slice(valueStart, start).trim()) {
        const params = stubParams(attribute, lua);
        items.push({
            label: `function(${params.join(", ")}) … end`,
            kind: CompletionItemKind.Snippet,
            detail: lua.returns ? `must return ${lua.returns}` : "called with what the engine passes",
            filterText: "function",
            sortText: "2function",
            textEdit: TextEdit.replace(r, `function(${params.join(", ")}) $0 end`),
            insertTextFormat: InsertTextFormat.Snippet,
        });
    }
    for (const name of engineNames) {
        if (seen.has(name) || name.startsWith("_") || !/^[A-Za-z]\w*$/.test(name)) continue;
        seen.add(name);
        items.push({ label: name, kind: CompletionItemKind.Module, detail: "engine", sortText: `3${name}`, textEdit: TextEdit.replace(r, name) });
    }
    return items;
}
