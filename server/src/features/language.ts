// Completion, hover, definition and document symbols.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    CompletionItem, CompletionItemKind, DocumentSymbol, Hover, InsertTextFormat, Location, MarkupKind, Range,
    SymbolKind, TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { findNodeAtLocation, findNodeAtOffset, getLocation, parseTree } from "jsonc-parser";
import { sanitizeJson } from "../../../shared/content/json";
import { parseLocale, translations } from "../../../shared/content/locale";
import { fileRole } from "../linter";
import { LintEnv } from "../rules/context";
import { scriptRole } from "../lua/analyze";
import { Callback, callbacksFor } from "../lua/spec";
import { fileToUri } from "../uri";
import { REF_LABEL, RefKind, candidates, displayPath, jsonStringAt, luaStringAt, resolveRef } from "./refs";
import { VcmLang, vcmCompletions, vcmHover, vcmOutline } from "./vcm";
import { modelHover, soundHover, textureFacesHover, textureHover, translationsHover } from "./assets";
import { layoutCompletions, layoutHover, layoutKeyAt, layoutSymbols } from "./layout";
import { bindingNames, preloadedFonts, preloadedTextures } from "./layoutAssets";
import { layoutRefs } from "./references";
import { layoutAttribute } from "../../../shared/layouts";
import { layoutContextAt } from "../../../shared/layouts/xml";
import { callbackCompletions, layoutDefinition } from "./layoutLua";
import { engineGlobals } from "../lua/globals";
import { documentIdCompletions, documentIdDefinition, documentIdHover } from "./layoutDocument";

const JSON_ROLES = new Set(["block", "item", "entity", "material", "skeleton", "preload"]);

function langOf(file: string): VcmLang | undefined {
    const ext = path.extname(file).toLowerCase();
    return ext === ".vcm" ? "vcm" : ext === ".vca" ? "vca" : undefined;
}

function range(doc: TextDocument, start: number, end: number): Range {
    return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

const KIND_ICON: Partial<Record<RefKind, CompletionItemKind>> = {
    blockTexture: CompletionItemKind.File,
    atlasTexture: CompletionItemKind.File,
    itemIcon: CompletionItemKind.File,
    texturePath: CompletionItemKind.File,
    model: CompletionItemKind.File,
    sound: CompletionItemKind.File,
    module: CompletionItemKind.Module,
    script: CompletionItemKind.File,
    layout: CompletionItemKind.File,
};

function refItems(env: LintEnv, kind: RefKind, fromPack: string | undefined, editRange: Range, quote: string): CompletionItem[] {
    return candidates(env.index, kind, fromPack).map((value) => ({
        label: value,
        kind: KIND_ICON[kind] ?? CompletionItemKind.Value,
        detail: REF_LABEL[kind],
        textEdit: TextEdit.replace(editRange, quote + value + quote),
        filterText: quote + value + quote,
    }));
}

function callbackStub(cb: Callback): string {
    return `function ${cb.name}(${cb.params.join(", ")})\n\t$0\nend`;
}

export function complete(env: LintEnv, doc: TextDocument, file: string, offset: number): CompletionItem[] {
    const text = doc.getText();
    const lang = langOf(file);
    if (lang) {
        const { items, start } = vcmCompletions(lang, text, offset);
        const r = range(doc, start, offset);
        return items.map((item) => ({
            label: item.label,
            kind: item.kind === "element" ? CompletionItemKind.Class : item.kind === "attribute" ? CompletionItemKind.Property
                : item.kind === "function" ? CompletionItemKind.Function : CompletionItemKind.EnumMember,
            detail: item.detail,
            documentation: item.documentation ? { kind: MarkupKind.Markdown, value: item.documentation } : undefined,
            textEdit: TextEdit.replace(r, item.insertText ?? item.label),
            insertTextFormat: item.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
        }));
    }
    const { pack, role } = fileRole(env.index, file);
    if (role === "layout") {
        // texture / model / layout names inside a value
        const ctx = layoutContextAt(text, offset);
        const type = ctx.kind === "value" ? layoutAttribute(ctx.tag, ctx.attribute)?.type : undefined;
        if (ctx.kind === "value" && (type === "texture" || type === "model" || type === "layout")) {
            let end = offset;
            while (end < text.length && text[end] !== ctx.quote && text[end] !== "\n") end++;
            const r = range(doc, ctx.start, end);
            if (type !== "texture") return refItems(env, type, pack?.id, r, "");
            // loaded textures by name, and atlas regions
            const loaded = preloadedTextures(env.index);
            return [
                ...refItems(env, "texturePath", pack?.id, r, "").filter((i) => loaded.has(String(i.label))),
                ...refItems(env, "atlasTexture", pack?.id, r, ""),
            ];
        }
        // loaded fonts, defined bindings
        if (ctx.kind === "value" && (type === "font" || type === "binding")) {
            let end = offset;
            while (end < text.length && text[end] !== ctx.quote && text[end] !== "\n") end++;
            const r = range(doc, ctx.start, end);
            const names = type === "font" ? preloadedFonts(env.index) : bindingNames(env.index);
            return [...names].sort().map((name) => ({ label: name, kind: CompletionItemKind.Value, detail: type, textEdit: TextEdit.replace(r, name) }));
        }
        // Lua callbacks: the layout script's functions, engine names
        const lua = ctx.kind === "value" ? layoutAttribute(ctx.tag, ctx.attribute)?.lua : undefined;
        if (ctx.kind === "value" && lua) {
            return callbackCompletions(text, file, offset, ctx.attribute, lua, ctx.start, engineGlobals(env.index.resPath), (s, e) => range(doc, s, e));
        }
        return layoutCompletions(doc, offset);
    }
    if (JSON_ROLES.has(role)) {
        const at = jsonStringAt(role, text, offset);
        if (!at) return [];
        const r = at.node ? range(doc, at.node.offset, at.node.offset + at.node.length) : range(doc, offset, offset);
        return refItems(env, at.kind, pack?.id, r, '"');
    }
    if (role === "lua") {
        // document.<id> in a layout script
        const ids = documentIdCompletions(doc, file, offset);
        if (ids) return ids;
        const str = luaStringAt(text, offset);
        if (str) {
            return refItems(env, str.kind, pack?.id, range(doc, str.start, str.end), "");
        }
        if (!pack && !env.index.projectFile(file)) return [];
        const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
        const prefix = text.slice(lineStart, offset);
        const kind = scriptRole(env.index, pack, file).kind;
        const callbacks = callbacksFor(kind);
        if (!callbacks) return [];
        // top-level (unindented) `function on_…` / `on_…`
        if (!/^(function\s+)?[A-Za-z_]*$/.test(prefix)) return [];
        const defined = new Set([...text.matchAll(/^\s*function\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]));
        const r = range(doc, lineStart, offset);
        return callbacks.filter((cb) => !defined.has(cb.name)).map((cb) => ({
            label: cb.name,
            kind: CompletionItemKind.Event,
            detail: `(${cb.params.join(", ")}) — engine callback`,
            documentation: { kind: MarkupKind.Markdown, value: cb.doc },
            filterText: prefix.startsWith("function") ? `function ${cb.name}` : cb.name,
            textEdit: TextEdit.replace(r, callbackStub(cb)),
            insertTextFormat: InsertTextFormat.Snippet,
        }));
    }
    return [];
}

function describeFile(env: LintEnv, file: string | undefined, kind: RefKind, value: string): string {
    if (!file) return `${REF_LABEL[kind]} \`${value}\` — **not found**`;
    return `${REF_LABEL[kind]} \`${value}\` → \`${displayPath(env.index, file)}\``;
}

const TEXTURE_KINDS = new Set<RefKind>(["blockTexture", "atlasTexture", "itemIcon", "texturePath"]);
const MODEL_FILE = /\.(vcm|obj|vec3)$/i;

/** Thumbnails, sound variants, model facts for a resolved reference (§3.9). */
function assetDetails(env: LintEnv, kind: RefKind, value: string, resolved: string | undefined): string {
    if (!resolved) return "";
    if (TEXTURE_KINDS.has(kind) && /\.png$/i.test(resolved)) return textureHover(env.index, resolved);
    if (kind === "sound") return soundHover(env.index, value, resolved);
    if ((kind === "model" || kind === "skeleton") && MODEL_FILE.test(resolved)) return modelHover(resolved);
    return "";
}

/** `texture-faces` at the cursor (the key or an element): the 6 faces with their engine labels. */
function textureFacesAt(env: LintEnv, text: string, offset: number, fromPack: string | undefined): { md: string; start: number; end: number } | undefined {
    const clean = sanitizeJson(text);
    const location = getLocation(clean, offset);
    const p = location.path;
    const at = p.findIndex((seg) => seg === "texture-faces");
    if (at < 0 || p.length > at + 2) return undefined;
    // top level, or inside state-based.variants[i]
    if (!(at === 0 || (at === 3 && p[0] === "state-based" && p[1] === "variants"))) return undefined;
    const root = parseTree(clean, [], { allowTrailingComma: true });
    const node = root && findNodeAtLocation(root, p.slice(0, at + 1));
    if (!node || node.type !== "array" || !node.parent) return undefined;
    const names = (node.children ?? []).map((c) => (c.type === "string" ? String(c.value) : "?"));
    if (names.length !== 6) return undefined;
    const files = names.map((n) => env.index.resolveTexture("blocks", n, fromPack));
    const key = node.parent.children?.[0];
    const start = location.isAtPropertyKey && key ? key.offset : node.offset;
    const end = location.isAtPropertyKey && key ? key.offset + key.length : node.offset + node.length;
    return { md: textureFacesHover(files, names), start, end };
}

/** `"caption"` / `"description"` of a block or item: its translations (§3.6). */
function captionAt(text: string, offset: number, role: string): { key: string; start: number; end: number } | undefined {
    if (role !== "block" && role !== "item") return undefined;
    const clean = sanitizeJson(text);
    const location = getLocation(clean, offset);
    if (location.isAtPropertyKey || location.path.length !== 1 || !["caption", "description"].includes(String(location.path[0]))) return undefined;
    const root = parseTree(clean, [], { allowTrailingComma: true });
    const node = root && findNodeAtOffset(root, offset, true);
    if (!node || node.type !== "string") return undefined;
    return { key: String(node.value), start: node.offset, end: node.offset + node.length };
}

/** `gui.str("key"[, "context"])` in Lua. */
function guiStrAt(text: string, offset: number): { key: string; start: number; end: number } | undefined {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = text.indexOf("\n", offset);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    for (const m of line.matchAll(/\bgui\.str\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1(?:\s*,\s*(["'])((?:\\.|(?!\3).)*)\3)?/g)) {
        const start = lineStart + m.index! + m[0].indexOf(m[1] + m[2]);
        if (offset < start || offset > start + m[2].length + 2) continue;
        // with a context the engine looks up "context.key" first (langs::get)
        return { key: m[4] ? `${m[4]}.${m[2]}` : m[2], start, end: start + m[2].length + 2 };
    }
    return undefined;
}

export function hover(env: LintEnv, doc: TextDocument, file: string, offset: number): Hover | null {
    const text = doc.getText();
    const lang = langOf(file);
    const { pack, role } = fileRole(env.index, file);
    const markdown = (value: string, start: number, end: number): Hover => ({ contents: { kind: MarkupKind.Markdown, value }, range: range(doc, start, end) });
    if (lang) {
        const h = vcmHover(lang, text, offset);
        if (!h) return null;
        if (h.attribute) {
            if (h.attribute.name !== "texture" || h.attribute.value.startsWith("$")) return null;
            const resolved = env.index.resolveTextureRef(h.attribute.value, pack?.id);
            const details = assetDetails(env, "atlasTexture", h.attribute.value, resolved);
            return markdown(describeFile(env, resolved, "atlasTexture", h.attribute.value) + (details ? `\n\n${details}` : ""), h.start, h.end);
        }
        return markdown(h.markdown, h.start, h.end);
    }
    if (role === "layout") {
        const key = layoutKeyAt(text, offset);
        if (key) {
            // langs::get: `context.key` first, then `key`
            const withContext = key.context ? `${key.context}.${key.key}` : undefined;
            const lookup = withContext && translations(env.index, withContext).length ? withContext : key.key;
            const head = key.context ? `\`@${key.key}\` in context \`${key.context}\` → key \`${lookup}\`\n\n` : "";
            return markdown(head + translationsHover(env.index, lookup), key.start, key.end);
        }
        if (!layoutRefs(text).some((r) => offset >= r.start && offset <= r.end)) return layoutHover(doc, offset);
    }
    if (role === "locale") {
        const entry = parseLocale(text).entries.find((e) => offset >= e.keyStart && offset <= e.valueEnd);
        if (!entry) return null;
        return markdown(translationsHover(env.index, entry.key), entry.keyStart, entry.keyEnd);
    }
    let kind: RefKind | undefined;
    let value = "";
    let start = offset;
    let end = offset;
    if (role === "layout") {
        // a texture / model / layout name (FEATURES.md §3.9)
        ({ kind, value, start, end } = layoutRefs(text).find((r) => offset >= r.start && offset <= r.end)!);
    } else if (JSON_ROLES.has(role)) {
        if (role === "block") {
            const faces = textureFacesAt(env, text, offset, pack?.id);
            if (faces && (getLocation(sanitizeJson(text), offset).isAtPropertyKey || !jsonStringAt(role, text, offset)?.node)) {
                return markdown(`**texture-faces** (engine order)\n\n${faces.md}`, faces.start, faces.end);
            }
        }
        const caption = captionAt(text, offset, role);
        if (caption) return markdown(translationsHover(env.index, caption.key), caption.start, caption.end);
        const at = jsonStringAt(role, text, offset);
        if (!at?.node) return null;
        kind = at.kind;
        value = at.value;
        start = at.node.offset;
        end = at.node.offset + at.node.length;
    } else if (role === "lua") {
        const id = documentIdHover(text, file, offset);
        if (id) return markdown(id.markdown, id.start, id.end);
        const str = luaStringAt(text, offset);
        if (!str) {
            const key = guiStrAt(text, offset);
            return key ? markdown(translationsHover(env.index, key.key), key.start, key.end) : null;
        }
        ({ kind, value, start, end } = str);
    }
    if (!kind) return null;
    const resolved = resolveRef(env.index, kind, value, pack?.id);
    let extra = "";
    if (kind === "item" && env.index.items.get(value)?.blockOf) extra = `\n\nimplicit item of block \`${env.index.items.get(value)!.blockOf}\``;
    const details = assetDetails(env, kind, value, resolved);
    // texture-faces elements: this face, then all six
    let faces = "";
    if (role === "block" && kind === "blockTexture") {
        const all = textureFacesAt(env, text, offset, pack?.id);
        if (all) faces = `\n\n${all.md}`;
    }
    return markdown(describeFile(env, resolved, kind, value) + extra + (details ? `\n\n${details}` : "") + faces, start, end);
}

export function definition(env: LintEnv, doc: TextDocument, file: string, offset: number): Location[] {
    const text = doc.getText();
    const lang = langOf(file);
    const { pack, role } = fileRole(env.index, file);
    let target: string | undefined;
    if (role === "layout") {
        const ref = layoutRefs(text).find((r) => offset >= r.start && offset <= r.end);
        if (ref) {
            const resolved = resolveRef(env.index, ref.kind, ref.value, pack?.id);
            return resolved && fs.existsSync(resolved) ? [{ uri: fileToUri(resolved), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] : [];
        }
        // a callback's function in the layout's .xml.lua
        const def = layoutDefinition(text, file, offset);
        if (!def) return [];
        const script = TextDocument.create(fileToUri(def.file), "lua", 0, fs.readFileSync(def.file, "utf8"));
        return [{ uri: fileToUri(def.file), range: range(script, def.start, def.end) }];
    }
    if (lang) {
        const h = vcmHover(lang, text, offset);
        if (h?.attribute?.name === "texture" && !h.attribute.value.startsWith("$")) {
            target = env.index.resolveTextureRef(h.attribute.value, pack?.id);
        }
    } else if (JSON_ROLES.has(role)) {
        const at = jsonStringAt(role, text, offset);
        if (at?.node) target = resolveRef(env.index, at.kind, at.value, pack?.id);
    } else if (role === "lua") {
        const id = documentIdDefinition(text, file, offset);
        if (id) {
            const layout = TextDocument.create(fileToUri(id.file), "xml", 0, id.text);
            return [{ uri: fileToUri(id.file), range: range(layout, id.start, id.end) }];
        }
        const str = luaStringAt(text, offset);
        if (str) target = resolveRef(env.index, str.kind, str.value, pack?.id);
        // project scripts: bare and `project:` modules are <project>/modules/<name>.lua
        const project = env.index.projectFile(file)?.project;
        if (str?.kind === "module" && project && (!str.value.includes(":") || str.value.startsWith("project:"))) {
            target = path.join(project.root, "modules", str.value.replace(/^project:/, "") + ".lua");
        }
    }
    if (!target || !fs.existsSync(target)) return [];
    return [{ uri: fileToUri(target), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
}

/** Locale file outline: `# comment` lines open sections, keys go under them. */
function localeSymbols(doc: TextDocument): DocumentSymbol[] {
    const parsed = parseLocale(doc.getText());
    const out: DocumentSymbol[] = [];
    let section: DocumentSymbol | undefined;
    const items = [
        ...parsed.comments.map((c) => ({ at: c.start, comment: c })),
        ...parsed.entries.map((e) => ({ at: e.keyStart, entry: e })),
    ].sort((a, b) => a.at - b.at);
    for (const item of items) {
        if ("comment" in item && item.comment) {
            const name = item.comment.text.replace(/^#+\s*/, "").trim();
            if (!name) continue;
            const r = range(doc, item.comment.start, item.comment.end);
            section = { name, kind: SymbolKind.Namespace, range: r, selectionRange: r, children: [] };
            out.push(section);
        } else if ("entry" in item && item.entry) {
            const e = item.entry;
            const symbol: DocumentSymbol = {
                name: e.key || "(empty key)",
                detail: e.value,
                kind: SymbolKind.String,
                range: range(doc, e.keyStart, e.valueEnd),
                selectionRange: range(doc, e.keyStart, e.keyEnd),
            };
            if (section) {
                section.children!.push(symbol);
                section.range = { start: section.range.start, end: symbol.range.end };
            } else out.push(symbol);
        }
    }
    return out;
}

export function documentSymbols(doc: TextDocument, file: string): DocumentSymbol[] {
    if (/[\\/]texts[\\/][^\\/]+\.txt$/i.test(file)) return localeSymbols(doc);
    if (/[\\/]layouts[\\/].+\.xml$/i.test(file)) return layoutSymbols(doc);
    const lang = langOf(file);
    if (!lang) return [];
    const kindOf: Record<string, SymbolKind> = {
        bone: SymbolKind.Class,
        primitive: SymbolKind.Struct,
        part: SymbolKind.Field,
        directive: SymbolKind.Event,
        key: SymbolKind.Key,
        other: SymbolKind.Object,
    };
    const convert = (n: ReturnType<typeof vcmOutline>[number]): DocumentSymbol => ({
        name: n.name,
        detail: n.detail,
        kind: kindOf[n.kind],
        range: range(doc, n.start, Math.max(n.end, n.selEnd)),
        selectionRange: range(doc, n.selStart, n.selEnd),
        children: n.children.map(convert),
    });
    return vcmOutline(lang, doc.getText()).map(convert);
}
