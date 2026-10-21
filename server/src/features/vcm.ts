// VCM/VCA editor features: context detection, completion, hover, outline.

import { VcmAttribute, VcmElement, getAttribute, parseVcm, walkVcm } from "../../../shared/vcm/parser";
import { AttrSpec, ElementSpec, VCA_ELEMENTS, VCA_FUNCTIONS, VCA_KEY, VCM_ELEMENTS, VCM_ROOT_CHILDREN, vcaElement, vcmElement } from "../vcm/spec";

export type VcmLang = "vcm" | "vca";

export function elementSpec(lang: VcmLang, tag: string): ElementSpec | undefined {
    return lang === "vcm" ? vcmElement(tag) : vcaElement(tag);
}

function allowedChildren(lang: VcmLang, parent: VcmElement | undefined): ElementSpec[] {
    if (lang === "vcm") {
        const tags = parent ? vcmElement(parent.tag)?.children ?? [] : VCM_ROOT_CHILDREN;
        return VCM_ELEMENTS.filter((e) => tags.includes(e.tag));
    }
    if (!parent) return VCA_ELEMENTS;
    return vcaElement(parent.tag)?.children?.includes("key") ? [VCA_KEY] : [];
}

/** Offset of the body `{` of an element, if any. */
function bodyStart(text: string, element: VcmElement): number | undefined {
    if (!element.hasBody) return undefined;
    const last = element.attributes[element.attributes.length - 1];
    const from = last ? last.valueSpan.end : element.tagSpan.end;
    const i = text.indexOf("{", from);
    return i >= 0 && i < element.span.end ? i : undefined;
}

function deepestBodyContaining(text: string, elements: VcmElement[], offset: number): VcmElement | undefined {
    let found: VcmElement | undefined;
    walkVcm(elements, (el) => {
        const open = bodyStart(text, el);
        if (open === undefined) return;
        const close = text[el.span.end - 1] === "}" ? el.span.end - 1 : el.span.end;
        if (offset > open && offset <= close) found = el;
    });
    return found;
}

interface LexToken {
    text: string;
    start: number;
    end: number;
}

/** Tokenizes an element header like the engine's VcmParser (names, strings, groups, words). */
function lexHeader(text: string, start: number, end: number): LexToken[] {
    const tokens: LexToken[] = [];
    let i = start;
    while (i < end) {
        const c = text[i];
        if (c === " " || c === "\t" || c === "\r" || c === "\n") {
            i++;
            continue;
        }
        if (c === "#") {
            while (i < end && text[i] !== "\n") i++;
            continue;
        }
        const s = i;
        if (c === '"' || c === "'") {
            i++;
            while (i < end && text[i] !== c && text[i] !== "\n") i++;
            if (i < end && text[i] === c) i++;
        } else if (c === "(") {
            let depth = 0;
            while (i < end) {
                const ch = text[i++];
                if (ch === "(") depth++;
                else if (ch === ")" && --depth === 0) break;
            }
        } else {
            while (i < end && !/\s/.test(text[i])) i++;
        }
        tokens.push({ text: text.slice(s, i), start: s, end: i });
    }
    return tokens;
}

export type VcmContext =
    | { type: "element"; parent?: VcmElement; prefixStart: number }
    | { type: "attribute"; element: VcmElement; prefixStart: number }
    | { type: "value"; element: VcmElement; attribute: string; prefixStart: number }
    | { type: "none" };

export function vcmContext(text: string, offset: number): VcmContext {
    const doc = parseVcm(text);
    // the word being typed
    let prefixStart = offset;
    while (prefixStart > 0 && /[A-Za-z0-9_\-.$:]/.test(text[prefixStart - 1])) prefixStart--;
    if (text[prefixStart - 1] === "@") {
        return { type: "element", parent: deepestBodyContaining(text, doc.elements, prefixStart - 1), prefixStart };
    }
    // the element whose header the cursor is in
    let header: VcmElement | undefined;
    walkVcm(doc.elements, (el) => {
        if (el.tagSpan.end <= prefixStart && (!header || el.tagSpan.start > header.tagSpan.start)) header = el;
    });
    if (!header) return { type: "none" };
    const open = bodyStart(text, header);
    const between = text.slice(header.tagSpan.end, prefixStart);
    if ((open !== undefined && open < prefixStart) || /[{}@]/.test(between.replace(/"[^"\n]*"|'[^'\n]*'|\([^)]*\)|#[^\n]*/g, ""))) {
        return { type: "none" };
    }
    const tokens = lexHeader(text, header.tagSpan.end, prefixStart);
    if (tokens.length % 2 === 0) return { type: "attribute", element: header, prefixStart };
    return { type: "value", element: header, attribute: tokens[tokens.length - 1].text, prefixStart };
}

export interface SimpleCompletion {
    label: string;
    kind: "element" | "attribute" | "value" | "function";
    detail?: string;
    documentation?: string;
    insertText?: string;
    snippet?: boolean;
}

export function vcmCompletions(lang: VcmLang, text: string, offset: number): { items: SimpleCompletion[]; start: number } {
    const ctx = vcmContext(text, offset);
    switch (ctx.type) {
        case "element": {
            const items = allowedChildren(lang, ctx.parent).map((spec): SimpleCompletion => {
                const required = spec.attributes.filter((a) => a.required);
                let n = 1;
                const snippet = spec.tag + required.map((a) => ` ${a.name} ${placeholder(a, n++)}`).join("");
                return { label: spec.tag, kind: "element", documentation: spec.doc, insertText: snippet, snippet: true };
            });
            return { items, start: ctx.prefixStart };
        }
        case "attribute": {
            const spec = elementSpec(lang, ctx.element.tag);
            if (!spec) return { items: [], start: ctx.prefixStart };
            const present = new Set(ctx.element.attributes.map((a) => a.name));
            const items = spec.attributes
                .filter((a) => !present.has(a.name) || ctx.element.attributes.some((x) => x.name === a.name && x.nameSpan.end >= ctx.prefixStart))
                .map((a): SimpleCompletion => ({ label: a.name, kind: "attribute", detail: a.type, documentation: a.doc }));
            return { items, start: ctx.prefixStart };
        }
        case "value": {
            const spec = elementSpec(lang, ctx.element.tag)?.attributes.find((a) => a.name === ctx.attribute);
            if (!spec) return { items: [], start: ctx.prefixStart };
            const items: SimpleCompletion[] = (spec.values ?? []).map((v) => ({ label: v, kind: "value" }));
            if (spec.type === "curve" && lang === "vca") {
                const doc = parseVcm(text);
                for (const el of doc.elements) {
                    const name = el.tag === "curve" ? getAttribute(el, "name")?.value : undefined;
                    if (name) items.push({ label: "." + name, kind: "value", detail: "custom curve" });
                }
            }
            if (spec.type === "expr") {
                for (const f of VCA_FUNCTIONS) items.push({ label: f, kind: "function", insertText: `${f}($1)`, snippet: true });
            }
            return { items, start: ctx.prefixStart };
        }
        default:
            return { items: [], start: offset };
    }
}

function placeholder(a: AttrSpec, n: number): string {
    switch (a.type) {
        case "vec3": return `(\${${n}:0, 0, 0})`;
        case "vec2": return `(\${${n}:1, 1})`;
        case "vec4": return `(\${${n}:0, 0, 1, 1})`;
        case "sides": return `(\${${n}:top})`;
        case "expr": return `(\${${n}:t})`;
        case "string": return `"\${${n}}"`;
        default: return `\${${n}}`;
    }
}

export interface VcmHover {
    markdown: string;
    start: number;
    end: number;
    /** attribute value hovered (for texture resolution) */
    attribute?: VcmAttribute;
}

export function vcmHover(lang: VcmLang, text: string, offset: number): VcmHover | undefined {
    const doc = parseVcm(text);
    let result: VcmHover | undefined;
    walkVcm(doc.elements, (el) => {
        if (result) return;
        const spec = elementSpec(lang, el.tag);
        if (offset >= el.tagSpan.start && offset <= el.tagSpan.end) {
            result = {
                markdown: spec ? `**@${el.tag}**\n\n${spec.doc}` : `Unknown element \`@${el.tag}\``,
                start: el.tagSpan.start,
                end: el.tagSpan.end,
            };
            return;
        }
        for (const attr of el.attributes) {
            const aspec = spec?.attributes.find((a) => a.name === attr.name);
            if (offset >= attr.nameSpan.start && offset <= attr.nameSpan.end) {
                result = {
                    markdown: aspec ? `**${attr.name}** (\`@${el.tag}\`, ${aspec.type})\n\n${aspec.doc}` : `Unknown attribute \`${attr.name}\` of \`@${el.tag}\``,
                    start: attr.nameSpan.start,
                    end: attr.nameSpan.end,
                };
                return;
            }
            if (offset >= attr.valueSpan.start && offset <= attr.valueSpan.end) {
                result = { markdown: "", start: attr.valueSpan.start, end: attr.valueSpan.end, attribute: attr };
                return;
            }
        }
    });
    return result;
}

export interface OutlineNode {
    name: string;
    detail: string;
    kind: "bone" | "primitive" | "part" | "directive" | "key" | "other";
    start: number;
    end: number;
    selStart: number;
    selEnd: number;
    children: OutlineNode[];
}

export function vcmOutline(lang: VcmLang, text: string): OutlineNode[] {
    const doc = parseVcm(text);
    const convert = (el: VcmElement): OutlineNode => {
        const name = getAttribute(el, "name")?.value;
        let detail = "";
        let kind: OutlineNode["kind"] = "other";
        if (lang === "vcm") {
            if (el.tag === "bone") {
                kind = "bone";
                detail = name ? "bone" : "unnamed bone";
            } else if (el.tag === "part") {
                kind = "part";
                detail = getAttribute(el, "tags")?.value ?? "";
            } else if (["box", "rect", "tri"].includes(el.tag)) {
                kind = "primitive";
                const from = getAttribute(el, "from")?.value ?? getAttribute(el, "a")?.value;
                const to = getAttribute(el, "to")?.value;
                detail = [from && `(${from})`, to && `→ (${to})`, getAttribute(el, "texture")?.value].filter(Boolean).join(" ");
            }
        } else {
            kind = el.tag === "key" ? "key" : "directive";
            detail = el.attributes.filter((a) => a.name !== "name").map((a) => `${a.name} ${a.kind === "group" ? `(${a.value})` : a.value}`).join(" ");
        }
        const label = name ? `@${el.tag} ${name}` : el.tag === "key" ? `@key ${getAttribute(el, "frame")?.value ?? ""}`.trim() : `@${el.tag}`;
        return {
            name: label,
            detail,
            kind,
            start: el.span.start,
            end: el.span.end,
            selStart: el.tagSpan.start,
            selEnd: el.tagSpan.end,
            children: el.children.map(convert),
        };
    };
    return doc.elements.map(convert);
}
