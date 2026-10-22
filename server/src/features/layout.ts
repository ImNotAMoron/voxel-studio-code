// Completion, hover, outline and colours for XML UI layouts (FEATURES.md §3.7).

import {
    Color, ColorInformation, ColorPresentation, CompletionItem, CompletionItemKind, DocumentSymbol, Hover, InsertTextFormat,
    MarkupKind, Range, SymbolKind, TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
    childTags, layoutAttribute, layoutElement, uiNodeTags, type LayoutAttribute, type LayoutElement,
} from "../../../shared/layouts";
import { layoutContextAt, parseLayoutXml, type Span, type XmlElement, type XmlNode } from "../../../shared/layouts/xml";
import { DOC_BASE } from "../rules/registry";

const DOC = `${DOC_BASE}doc/en/xml-ui-layouts.md`;
const SOURCE = `${DOC_BASE}src/graphics/ui/gui_xml.cpp`;

function range(doc: TextDocument, start: number, end: number): Range {
    return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

const TYPE_TEXT: Record<string, string> = {
    string: "text",
    bool: "boolean: `true` or `1` (anything else is false)",
    int: "integer",
    number: "number",
    vec2: "2D vector `x,y` (one number sets both)",
    vec3: "3D vector `x,y,z` (one number sets all three)",
    vec4: "4D vector `x,y,z,w` (one number sets all four)",
    color: "color `#RRGGBB`, `#RRGGBBAA` or `r,g,b,a` (0–255)",
    id: "element id (`document.<id>` in the layout script)",
    font: "font name",
    texture: "texture name (`textures/` without `.png`, e.g. `gui/error`)",
    model: "model name",
    layout: "layout id `pack:name` (`pack/layouts/name.xml`)",
    binding: "input binding name",
    "locale-context": "locale context for `@key` texts inside",
    condition: "condition: `''`, `false` and `nil` skip the element",
};

const GROUP_TEXT: Record<LayoutAttribute["group"], string> = {
    template: "every element (checked before it's read)",
    node: "every element",
    container: "every container",
    panel: "every panel",
    element: "this element",
};

function luaText(attr: LayoutAttribute): string {
    const lua = attr.lua!;
    if (lua.kind === "chunk") return "Lua code (statements), run when the event fires; the layout script's functions are in scope";
    const params = (lua.args ?? []).join(", ");
    return `Lua expression, evaluated each time; a function result is called` +
        ` — \`function(${params})${lua.returns ? `\` → \`${lua.returns}` : ""}\``;
}

function typeLine(attr: LayoutAttribute): string {
    if (attr.type === "lua") return luaText(attr);
    if (attr.type === "enum") return `one of ${attr.values!.map((v) => `\`${v}\``).join(" | ")}`;
    return TYPE_TEXT[attr.type] ?? attr.type;
}

export function attributeMarkdown(tag: string, name: string, attr: LayoutAttribute): string {
    const lines = [`**${name}** on \`<${tag}>\` — read for ${GROUP_TEXT[attr.group]}`, "", typeLine(attr)];
    if (attr.default !== undefined) lines[2] += ` · default \`${attr.default}\``;
    if (attr.localizable) lines.push("", "`@key` is looked up in the locales.");
    if (attr.description) lines.push("", attr.description);
    if (attr.valueDescriptions) {
        lines.push("", ...Object.entries(attr.valueDescriptions).map(([v, d]) => `- \`${v}\` — ${d}`));
    }
    if (!attr.description) lines.push("", `_Not in the docs; read by the engine (${SOURCE.replace(DOC_BASE, "")})._`);
    return lines.join("\n");
}

export function elementMarkdown(tag: string, element: LayoutElement): string {
    const lines = [`**<${tag}>** — [\`${element.reader}\`](${SOURCE})`];
    if (element.parent) lines.push("", `Only read directly inside \`<${element.parent}>\`.`);
    if (element.description) lines.push("", element.description);
    const content: string[] = [];
    if (element.content.children) content.push(element.content.children.map((c) => `\`<${c}>\``).join(", "));
    if (element.content.elements) content.push("child elements");
    if (element.content.text) content.push("inner text (`@key` is translated)");
    lines.push("", content.length ? `Reads: ${content.join(" · ")}` : "Reads no child elements or text.");
    if (!element.description) lines.push("", "_Not in the docs yet._");
    lines.push("", `[Layout docs](${DOC})`);
    return lines.join("\n");
}

function firstSentence(text: string | undefined): string | undefined {
    return text?.split(/(?<=\.)\s/)[0];
}

const GROUP_ORDER: Record<LayoutAttribute["group"], number> = { element: 0, panel: 1, container: 2, node: 3, template: 4 };

function valueSnippet(attr: LayoutAttribute | undefined): string {
    if (attr?.type === "bool") return '"${1|true,false|}"';
    if (attr?.type === "enum" && attr.values!.length) return `"\${1|${attr.values!.join(",")}|}"`;
    return '"$1"';
}

export function layoutCompletions(doc: TextDocument, offset: number): CompletionItem[] {
    const text = doc.getText();
    const ctx = layoutContextAt(text, offset);
    const md = (value: string) => ({ kind: MarkupKind.Markdown, value });
    switch (ctx.kind) {
        case "tag": {
            const parent = ctx.parent && layoutElement(ctx.parent) ? ctx.parent : undefined;
            const tags = parent ? childTags(parent) : uiNodeTags();
            const sub = new Set(parent ? layoutElement(parent)!.content.children ?? [] : []);
            const r = range(doc, ctx.start, offset);
            return tags.map((tag) => {
                const element = layoutElement(tag)!;
                const empty = !element.content.text && !element.content.elements && !element.content.children;
                return {
                    label: tag,
                    kind: CompletionItemKind.Class,
                    detail: firstSentence(element.description) ?? (element.parent ? `inside <${element.parent}>` : "UI element"),
                    documentation: md(elementMarkdown(tag, element)),
                    sortText: `${sub.has(tag) ? 0 : 1}${tag}`,
                    textEdit: TextEdit.replace(r, empty ? `${tag}$1/>` : `${tag}$1>$0</${tag}>`),
                    insertTextFormat: InsertTextFormat.Snippet,
                };
            });
        }
        case "closeTag": {
            if (!ctx.open) return [];
            const closed = text[offset] === ">";
            return [{
                label: ctx.open,
                kind: CompletionItemKind.Class,
                detail: `close <${ctx.open}>`,
                textEdit: TextEdit.replace(range(doc, ctx.start, offset), closed ? ctx.open : `${ctx.open}>`),
            }];
        }
        case "attribute": {
            const element = layoutElement(ctx.tag);
            if (!element) return [];
            let end = offset;
            while (end < text.length && /[\w:.-]/.test(text[end])) end++;
            const hasValue = /^\s*=/.test(text.slice(end));
            const r = range(doc, ctx.start, end);
            return Object.entries(element.attributes)
                .filter(([name]) => !ctx.present.includes(name))
                .map(([name, attr]) => ({
                    label: name,
                    kind: attr.lua ? CompletionItemKind.Event : CompletionItemKind.Property,
                    detail: attr.type === "lua" ? (attr.lua!.kind === "chunk" ? "Lua code" : "Lua expression") : attr.type === "enum" ? attr.values!.join(" | ") : TYPE_TEXT[attr.type]?.split(/[ :(]/)[0] ?? attr.type,
                    documentation: md(attributeMarkdown(ctx.tag, name, attr)),
                    sortText: `${GROUP_ORDER[attr.group]}${name}`,
                    textEdit: TextEdit.replace(r, hasValue ? name : `${name}=${valueSnippet(attr)}`),
                    insertTextFormat: hasValue ? InsertTextFormat.PlainText : InsertTextFormat.Snippet,
                }));
        }
        case "value": {
            const attr = layoutAttribute(ctx.tag, ctx.attribute);
            if (!attr) return [];
            const values = attr.type === "bool" ? ["true", "false"] : attr.type === "enum" ? attr.values! : [];
            const r = range(doc, ctx.start, offset);
            return values.map((value) => ({
                label: value,
                kind: CompletionItemKind.EnumMember,
                detail: value === attr.default ? "default" : undefined,
                documentation: attr.valueDescriptions?.[value] ? md(attr.valueDescriptions[value]) : undefined,
                textEdit: TextEdit.replace(r, value),
            }));
        }
        default:
            return [];
    }
}

const inside = (span: Span | undefined, offset: number) => !!span && offset >= span.start && offset <= span.end;

function elementAt(node: XmlNode | undefined, offset: number): XmlElement | undefined {
    if (!node || node.type !== "element" || !inside(node.span, offset)) return undefined;
    for (const child of node.children) {
        const found = elementAt(child, offset);
        if (found) return found;
    }
    return node;
}

export function layoutHover(doc: TextDocument, offset: number): Hover | null {
    const tree = parseLayoutXml(doc.getText());
    const element = elementAt(tree.root, offset);
    if (!element) return null;
    const markdown = (value: string, span: Span): Hover => ({ contents: { kind: MarkupKind.Markdown, value }, range: range(doc, span.start, span.end) });
    const info = layoutElement(element.tag);
    if (!info) return null;
    const closeName = element.closeTagSpan && { start: element.closeTagSpan.start + 2, end: element.closeTagSpan.start + 2 + element.tag.length };
    if (inside(element.tagSpan, offset)) return markdown(elementMarkdown(element.tag, info), element.tagSpan);
    if (closeName && inside(closeName, offset)) return markdown(elementMarkdown(element.tag, info), closeName);
    for (const a of element.attributes) {
        const attr = layoutAttribute(element.tag, a.name);
        if (!attr) continue;
        if (inside(a.nameSpan, offset)) return markdown(attributeMarkdown(element.tag, a.name, attr), a.nameSpan);
        if (a.valueSpan && inside(a.valueSpan, offset)) {
            const valueDoc = attr.valueDescriptions?.[a.value];
            const head = valueDoc ? `\`${a.value}\` — ${valueDoc}\n\n---\n\n` : "";
            return markdown(head + attributeMarkdown(element.tag, a.name, attr), a.valueSpan);
        }
    }
    return null;
}

export function layoutSymbols(doc: TextDocument): DocumentSymbol[] {
    const tree = parseLayoutXml(doc.getText());
    const convert = (element: XmlElement): DocumentSymbol => {
        const id = element.attributes.filter((a) => a.name === "id").pop()?.value;
        const text = element.children.find((c) => c.type === "text");
        const info = layoutElement(element.tag);
        return {
            name: id ? `<${element.tag}> #${id}` : `<${element.tag}>`,
            detail: text?.type === "text" ? text.value.trim().slice(0, 40) : undefined,
            kind: info?.content.elements || info?.content.children ? SymbolKind.Class : SymbolKind.Field,
            range: range(doc, element.span.start, Math.max(element.span.end, element.tagSpan.end)),
            selectionRange: range(doc, element.tagSpan.start, element.tagSpan.end),
            children: element.children.filter((c): c is XmlElement => c.type === "element").map(convert),
        };
    };
    return tree.root?.type === "element" ? [convert(tree.root)] : [];
}

// ---------------------------------------------------------------- colours

/** A colour value as the engine reads it (Attribute::asColor), in 0..1; undefined if it doesn't parse cleanly. */
export function parseLayoutColor(text: string): Color | undefined {
    if (text.startsWith("#")) {
        if (!/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text)) return undefined;
        const n = (i: number) => parseInt(text.slice(i, i + 2), 16) / 255;
        return { red: n(1), green: n(3), blue: n(5), alpha: text.length === 9 ? n(7) : 1 };
    }
    // r,g,b,a in 0..255, or one number for all four (asVec4() / 255)
    const parts = text.split(",").map((p) => p.trim());
    if (parts.length !== 1 && parts.length !== 4) return undefined;
    if (!parts.every((p) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(p))) return undefined;
    const [r, g, b, a] = (parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]] : parts).map((p) => Number(p) / 255);
    return { red: r, green: g, blue: b, alpha: a };
}

export function layoutColors(doc: TextDocument): ColorInformation[] {
    const text = doc.getText();
    const tree = parseLayoutXml(text);
    const out: ColorInformation[] = [];
    const visit = (node: XmlNode | undefined) => {
        if (!node || node.type !== "element") return;
        for (const a of node.attributes) {
            if (!a.valueSpan || layoutAttribute(node.tag, a.name)?.type !== "color") continue;
            // only plain values: no escapes or entities between the quotes
            if (text.slice(a.valueSpan.start, a.valueSpan.end) !== a.value) continue;
            const color = parseLayoutColor(a.value);
            if (color) out.push({ color, range: range(doc, a.valueSpan.start, a.valueSpan.end) });
        }
        node.children.forEach(visit);
    };
    visit(tree.root);
    return out;
}

/** Text for a picked colour: the value's own format first (hex keeps its case and length), then the other. */
export function layoutColorPresentations(current: string, color: Color): ColorPresentation[] {
    const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    const [r, g, b, a] = [color.red, color.green, color.blue, color.alpha].map(byte);
    const lower = /^#[0-9a-f]*$/.test(current) && /[a-f]/.test(current);
    const h = (v: number) => {
        const s = v.toString(16).padStart(2, "0");
        return lower ? s : s.toUpperCase();
    };
    const hex = `#${h(r)}${h(g)}${h(b)}` + (a !== 255 || current.length === 9 ? h(a) : "");
    const numbers = `${r},${g},${b},${a}`;
    const labels = current.startsWith("#") || current === "" ? [hex, numbers] : [numbers, hex];
    return labels.map((label) => ({ label }));
}

// ---------------------------------------------------------------- @key texts

export interface LayoutKey {
    key: string;
    /** The `context` in effect (UiXmlReader's context stack); "" for none. */
    context: string;
    start: number;
    end: number;
}

/**
 * The `@key` text at `offset`: inner text (parse_inner_text, trimmed) or a
 * localizable attribute (tooltip, hint). The key is looked up as
 * `context.key` first, then `key` (langs::get).
 */
export function layoutKeyAt(text: string, offset: number): LayoutKey | undefined {
    const tree = parseLayoutXml(text);
    const visit = (node: XmlNode | undefined, context: string): LayoutKey | undefined => {
        if (!node || node.type !== "element" || offset < node.span.start || offset > node.span.end) return undefined;
        // readUINode pushes the element's own context before reading it
        const own = node.attributes.filter((a) => a.name === "context").pop();
        const ctx = own ? own.value : context;
        const info = layoutElement(node.tag);
        for (const a of node.attributes) {
            if (!a.valueSpan || offset < a.valueSpan.start || offset > a.valueSpan.end) continue;
            if (!layoutAttribute(node.tag, a.name)?.localizable || !a.value.startsWith("@")) return undefined;
            if (text.slice(a.valueSpan.start, a.valueSpan.end) !== a.value) return undefined;
            return { key: a.value.slice(1), context: ctx, start: a.valueSpan.start, end: a.valueSpan.end };
        }
        for (const child of node.children) {
            if (child.type === "text") {
                if (offset < child.span.start || offset > child.span.end || !info?.content.text) continue;
                const raw = text.slice(child.span.start, child.span.end);
                const trimmed = child.value.trim();
                if (!trimmed.startsWith("@") || raw !== child.value) return undefined;
                const at = child.span.start + raw.indexOf(trimmed);
                // a select's own text is read without the context (parse_inner_text(element, ""))
                return { key: trimmed.slice(1), context: node.tag === "select" ? "" : ctx, start: at, end: at + trimmed.length };
            }
            const found = visit(child, ctx);
            if (found) return found;
        }
        return undefined;
    };
    return visit(tree.root, "");
}
