// `document.<id>` in a layout script (`<name>.xml.lua`): completion, hover and
// go to definition from the ids of the sibling `<name>.xml` (FEATURES.md §3.7).

import * as fs from "node:fs";
import { CompletionItem, CompletionItemKind, MarkupKind, TextEdit } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { layoutElement } from "../../../shared/layouts";
import { documentIds } from "../../../shared/layouts/ids";
import { parseLayoutXml, type XmlElement } from "../../../shared/layouts/xml";
import { elementMarkdown } from "./layout";

export interface LayoutOfScript {
    file: string;
    text: string;
    ids: Map<string, XmlElement>;
}

/** The layout a `.xml.lua` belongs to, with the ids the engine indexes. */
export function layoutOfScript(scriptFile: string): LayoutOfScript | undefined {
    if (!/\.xml\.lua$/i.test(scriptFile)) return undefined;
    const file = scriptFile.slice(0, -4);
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
    return { file, text, ids: documentIds(parseLayoutXml(text).root) };
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length;

function describe(layout: LayoutOfScript, id: string, element: XmlElement): string {
    const info = layoutElement(element.tag);
    const where = `\`${id}\` → \`<${element.tag}>\` on line ${lineOf(layout.text, element.span.start)} of the layout`;
    const root = id === "root" ? "\n\nThe root element is always `document.root` (UiDocument::read)." : "";
    return where + root + (info ? `\n\n---\n\n${elementMarkdown(element.tag, info)}` : "");
}

/** Completion after `document.` or `document["`. */
export function documentIdCompletions(doc: TextDocument, scriptFile: string, offset: number): CompletionItem[] | undefined {
    const text = doc.getText();
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const before = text.slice(lineStart, offset);
    const dot = /\bdocument\s*\.\s*([A-Za-z_]\w*)?$/.exec(before);
    const bracket = /\bdocument\s*\[\s*(["'])([^"'\n]*)$/.exec(before);
    if (!dot && !bracket) return undefined;
    const layout = layoutOfScript(scriptFile);
    if (!layout) return undefined;
    const typed = dot ? dot[1] ?? "" : bracket![2];
    let end = offset;
    while (end < text.length && /[\w-]/.test(text[end])) end++;
    const r = { start: doc.positionAt(offset - typed.length), end: doc.positionAt(end) };
    const items: CompletionItem[] = [];
    for (const [id, element] of layout.ids) {
        // `document.x` needs a Lua identifier; others only work as document["x-y"]
        if (dot && !/^[A-Za-z_]\w*$/.test(id)) continue;
        items.push({
            label: id,
            kind: CompletionItemKind.Field,
            detail: `<${element.tag}> · line ${lineOf(layout.text, element.span.start)}`,
            documentation: { kind: MarkupKind.Markdown, value: describe(layout, id, element) },
            sortText: id === "root" ? `1${id}` : `0${id}`,
            textEdit: TextEdit.replace(r, id),
        });
    }
    return items;
}

/** `document.x` / `document["x"]` at `offset` in a layout script. */
function idAt(text: string, offset: number): { id: string; start: number; end: number } | undefined {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lineEnd = text.indexOf("\n", offset);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    for (const m of line.matchAll(/\bdocument\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*(["'])([^"'\n]+)\2\s*\])/g)) {
        const id = m[1] ?? m[3];
        const start = lineStart + m.index! + m[0].lastIndexOf(id);
        if (offset >= start && offset <= start + id.length) return { id, start, end: start + id.length };
    }
    return undefined;
}

export function documentIdHover(text: string, scriptFile: string, offset: number): { markdown: string; start: number; end: number } | undefined {
    const at = idAt(text, offset);
    const layout = at && layoutOfScript(scriptFile);
    const element = layout?.ids.get(at!.id);
    if (!at || !layout || !element) return undefined;
    return { markdown: describe(layout, at.id, element), start: at.start, end: at.end };
}

export function documentIdDefinition(text: string, scriptFile: string, offset: number): { file: string; text: string; start: number; end: number } | undefined {
    const at = idAt(text, offset);
    const layout = at && layoutOfScript(scriptFile);
    const element = layout?.ids.get(at!.id);
    if (!layout || !element) return undefined;
    return { file: layout.file, text: layout.text, start: element.tagSpan.start, end: element.tagSpan.end };
}
