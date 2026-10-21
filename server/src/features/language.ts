// Completion, hover, definition and document symbols.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    CompletionItem, CompletionItemKind, DocumentSymbol, Hover, InsertTextFormat, Location, MarkupKind, Range,
    SymbolKind, TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileRole } from "../linter";
import { LintEnv } from "../rules/context";
import { scriptRole } from "../lua/analyze";
import { Callback, callbacksFor } from "../lua/spec";
import { fileToUri } from "../uri";
import { REF_LABEL, RefKind, candidates, displayPath, jsonStringAt, luaStringAt, resolveRef } from "./refs";
import { VcmLang, vcmCompletions, vcmHover, vcmOutline } from "./vcm";

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
    if (JSON_ROLES.has(role)) {
        const at = jsonStringAt(role, text, offset);
        if (!at) return [];
        const r = at.node ? range(doc, at.node.offset, at.node.offset + at.node.length) : range(doc, offset, offset);
        return refItems(env, at.kind, pack?.id, r, '"');
    }
    if (role === "lua") {
        const str = luaStringAt(text, offset);
        if (str) {
            return refItems(env, str.kind, pack?.id, range(doc, str.start, str.end), "");
        }
        if (!pack) return [];
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

export function hover(env: LintEnv, doc: TextDocument, file: string, offset: number): Hover | null {
    const text = doc.getText();
    const lang = langOf(file);
    const { pack, role } = fileRole(env.index, file);
    if (lang) {
        const h = vcmHover(lang, text, offset);
        if (!h) return null;
        if (h.attribute) {
            if (h.attribute.name !== "texture" || h.attribute.value.startsWith("$")) return null;
            const resolved = env.index.resolveTextureRef(h.attribute.value, pack?.id);
            return { contents: { kind: MarkupKind.Markdown, value: describeFile(env, resolved, "atlasTexture", h.attribute.value) }, range: range(doc, h.start, h.end) };
        }
        return { contents: { kind: MarkupKind.Markdown, value: h.markdown }, range: range(doc, h.start, h.end) };
    }
    let kind: RefKind | undefined;
    let value = "";
    let start = offset;
    let end = offset;
    if (JSON_ROLES.has(role)) {
        const at = jsonStringAt(role, text, offset);
        if (!at?.node) return null;
        kind = at.kind;
        value = at.value;
        start = at.node.offset;
        end = at.node.offset + at.node.length;
    } else if (role === "lua") {
        const str = luaStringAt(text, offset);
        if (!str) return null;
        ({ kind, value, start, end } = str);
    }
    if (!kind) return null;
    const resolved = resolveRef(env.index, kind, value, pack?.id);
    let extra = "";
    if (kind === "item" && env.index.items.get(value)?.blockOf) extra = `\n\nimplicit item of block \`${env.index.items.get(value)!.blockOf}\``;
    return { contents: { kind: MarkupKind.Markdown, value: describeFile(env, resolved, kind, value) + extra }, range: range(doc, start, end) };
}

export function definition(env: LintEnv, doc: TextDocument, file: string, offset: number): Location[] {
    const text = doc.getText();
    const lang = langOf(file);
    const { pack, role } = fileRole(env.index, file);
    let target: string | undefined;
    if (lang) {
        const h = vcmHover(lang, text, offset);
        if (h?.attribute?.name === "texture" && !h.attribute.value.startsWith("$")) {
            target = env.index.resolveTextureRef(h.attribute.value, pack?.id);
        }
    } else if (JSON_ROLES.has(role)) {
        const at = jsonStringAt(role, text, offset);
        if (at?.node) target = resolveRef(env.index, at.kind, at.value, pack?.id);
    } else if (role === "lua") {
        const str = luaStringAt(text, offset);
        if (str) target = resolveRef(env.index, str.kind, str.value, pack?.id);
    }
    if (!target || !fs.existsSync(target)) return [];
    return [{ uri: fileToUri(target), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
}

export function documentSymbols(doc: TextDocument, file: string): DocumentSymbol[] {
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
