// Names shared by a layout and its script (FEATURES.md §3.7): the script's
// global functions, called from callback attributes, and element ids, used
// as `document.<id>`. Find references and rename cover both files.

import * as path from "node:path";
import { layoutAttribute, layoutElement } from "../../../shared/layouts";
import { parseLayoutXml, walkElements, type XmlAttribute } from "../../../shared/layouts/xml";
import { LuaNode, parseLua, walkLua } from "../lua/analyze";
import { callbackLua } from "./layoutLua";

export interface LayoutName {
    kind: "function" | "id";
    name: string;
    layoutFile: string;
    scriptFile: string;
    /** The occurrence under the cursor. */
    start: number;
    end: number;
}

export interface NameOccurrence {
    file: string;
    start: number;
    end: number;
    /** `document.x` (a Lua field name: a new id must be an identifier). */
    dotted?: boolean;
}

type GetText = (file: string) => string | undefined;

const LUA_IDENT = /^[A-Za-z_]\w*$/;
const LUA_KEYWORDS = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not",
    "or", "repeat", "return", "then", "true", "until", "while",
]);

function filesOf(file: string): { layoutFile: string; scriptFile: string } | undefined {
    if (/\.xml\.lua$/i.test(file)) return { layoutFile: file.slice(0, -4), scriptFile: file };
    if (/\.xml$/i.test(file) && /[\\/]layouts[\\/]/.test(file)) return { layoutFile: file, scriptFile: file + ".lua" };
    return undefined;
}

/** Global identifiers of a Lua chunk: definitions (function / assignment targets) and reads. */
function globalIdentifiers(chunk: LuaNode): { name: string; start: number; end: number }[] {
    const out: { name: string; start: number; end: number }[] = [];
    walkLua(chunk, (node, parent, key) => {
        if (node.type !== "Identifier" || !node.range || node.isLocal) return;
        if (parent?.type === "MemberExpression" && key === "identifier") return; // a.b: b is a field
        if (parent?.type === "TableKeyString" && key === "key") return; // { b = 1 }
        if (parent?.type === "FunctionDeclaration" && key === "parameters") return;
        out.push({ name: node.name as string, start: node.range[0], end: node.range[1] });
    });
    return out;
}

/** Callback attributes of the layout reading global `name`. */
function callbackOccurrences(layoutFile: string, text: string, name: string): NameOccurrence[] {
    const out: NameOccurrence[] = [];
    for (const { element } of walkElements(parseLayoutXml(text).root)) {
        for (const a of element.attributes) {
            const lua = layoutAttribute(element.tag, a.name)?.lua;
            const parsed = lua && callbackLua(text, a, lua);
            if (!parsed) continue;
            for (const g of parsed.globals) if (g.name === name && g.end > g.start) out.push({ file: layoutFile, start: g.start, end: g.end });
        }
    }
    return out;
}

const DOCUMENT_ID = /\bdocument\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*(["'])([^"'\n]+)\2\s*\])/g;

function documentUses(scriptFile: string, text: string, id?: string): (NameOccurrence & { id: string })[] {
    const out: (NameOccurrence & { id: string })[] = [];
    for (const m of text.matchAll(DOCUMENT_ID)) {
        const name = m[1] ?? m[3];
        if (id !== undefined && name !== id) continue;
        const start = m.index! + m[0].lastIndexOf(name);
        out.push({ file: scriptFile, start, end: start + name.length, dotted: !!m[1], id: name });
    }
    return out;
}

function idAttributes(layoutFile: string, text: string, id?: string): (NameOccurrence & { id: string; attr: XmlAttribute })[] {
    const out: (NameOccurrence & { id: string; attr: XmlAttribute })[] = [];
    for (const { element } of walkElements(parseLayoutXml(text).root)) {
        if (!layoutElement(element.tag)) continue;
        for (const a of element.attributes) {
            if (a.name !== "id" || !a.valueSpan || !a.value || a.value.includes("%{")) continue;
            if (text.slice(a.valueSpan.start, a.valueSpan.end) !== a.value) continue;
            if (id !== undefined && a.value !== id) continue;
            out.push({ file: layoutFile, start: a.valueSpan.start, end: a.valueSpan.end, id: a.value, attr: a });
        }
    }
    return out;
}

/** The layout function or element id at `offset` of a layout or its script. */
export function layoutNameAt(file: string, text: string, offset: number, getText: GetText): LayoutName | undefined {
    const files = filesOf(file);
    if (!files) return undefined;
    const inside = (o: { start: number; end: number }) => offset >= o.start && offset <= o.end;
    if (file === files.scriptFile) {
        const use = documentUses(file, text).find(inside);
        if (use) return use.id === "root" ? undefined : { kind: "id", name: use.id, ...files, start: use.start, end: use.end };
        const { chunk } = parseLua(text);
        const g = chunk && globalIdentifiers(chunk).find(inside);
        // a global the layout calls, or a top-level function of the script
        if (!g) return undefined;
        const layoutText = getText(files.layoutFile);
        const called = layoutText !== undefined && callbackOccurrences(files.layoutFile, layoutText, g.name).length > 0;
        const defined = new RegExp(`^\\s*function\\s+${g.name}\\s*\\(`, "m").test(text);
        return called || defined ? { kind: "function", name: g.name, ...files, start: g.start, end: g.end } : undefined;
    }
    const id = idAttributes(file, text).find(inside);
    if (id) return { kind: "id", name: id.id, ...files, start: id.start, end: id.end };
    for (const { element } of walkElements(parseLayoutXml(text).root)) {
        for (const a of element.attributes) {
            if (!a.valueSpan || offset < a.valueSpan.start || offset > a.valueSpan.end) continue;
            const lua = layoutAttribute(element.tag, a.name)?.lua;
            const g = lua && callbackLua(text, a, lua)?.globals.find((x) => inside(x) && x.end > x.start);
            if (g) return { kind: "function", name: g.name, ...files, start: g.start, end: g.end };
        }
    }
    return undefined;
}

/** Every occurrence of the name in the layout and its script. */
export function layoutNameOccurrences(symbol: LayoutName, getText: GetText): NameOccurrence[] {
    const layoutText = getText(symbol.layoutFile);
    const scriptText = getText(symbol.scriptFile);
    const out: NameOccurrence[] = [];
    if (symbol.kind === "function") {
        if (scriptText !== undefined) {
            const { chunk } = parseLua(scriptText);
            if (chunk) for (const g of globalIdentifiers(chunk)) if (g.name === symbol.name) out.push({ file: symbol.scriptFile, start: g.start, end: g.end });
        }
        if (layoutText !== undefined) out.push(...callbackOccurrences(symbol.layoutFile, layoutText, symbol.name));
    } else {
        if (layoutText !== undefined) out.push(...idAttributes(symbol.layoutFile, layoutText, symbol.name));
        if (scriptText !== undefined) out.push(...documentUses(symbol.scriptFile, scriptText, symbol.name));
    }
    return out;
}

/** Why `newName` can't replace the symbol, or undefined. */
export function checkLayoutRename(symbol: LayoutName, newName: string, getText: GetText): string | undefined {
    const occurrences = layoutNameOccurrences(symbol, getText);
    if (symbol.kind === "function") {
        if (!LUA_IDENT.test(newName) || LUA_KEYWORDS.has(newName)) return `'${newName}' isn't a Lua name`;
        const script = getText(symbol.scriptFile);
        if (script && new RegExp(`^\\s*function\\s+${newName}\\s*\\(`, "m").test(script)) return `${path.basename(symbol.scriptFile)} already defines '${newName}'`;
        return undefined;
    }
    if (!newName || /["'<>&\s]/.test(newName)) return `'${newName}' can't be an element id`;
    if (newName === "root") return "'root' is the layout's root element (document.root)";
    if (occurrences.some((o) => (o as NameOccurrence).dotted) && !LUA_IDENT.test(newName)) {
        return `'${newName}' isn't a Lua name, and the script uses document.${symbol.name}`;
    }
    const layout = getText(symbol.layoutFile);
    if (layout && idAttributes(symbol.layoutFile, layout, newName).length) return `another element already has the id '${newName}'`;
    return undefined;
}
