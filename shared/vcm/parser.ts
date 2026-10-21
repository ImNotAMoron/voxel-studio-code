// VCM/VCA text parser. Mirrors the engine's `xml::VcmParser`
// (src/coders/xml.cpp) and `BasicParser` lexing rules (src/coders/
// BasicParser.inl, commons.hpp), but keeps source offsets and recovers from
// errors so it can drive diagnostics, outlines and the model preview.
//
// Grammar (as implemented by the engine):
//   elements  := element*
//   element   := '@' name attribute* ('{' elements '}')?
//   attribute := name value
//   value     := quoted-string | '(' ... ')' (nested parens) | bare-word
//   comments  := '#' to end of line, allowed wherever whitespace is

export interface Span {
    /** Offset of the first character. */
    start: number;
    /** Offset after the last character. */
    end: number;
}

export interface VcmAttribute {
    name: string;
    nameSpan: Span;
    /** Value text as the engine sees it (quotes / outer parens removed). */
    value: string;
    valueSpan: Span;
    kind: "string" | "group" | "word";
}

export interface VcmElement {
    tag: string;
    /** Span of `@tag`. */
    tagSpan: Span;
    /** Whole element including its `{...}` body. */
    span: Span;
    attributes: VcmAttribute[];
    children: VcmElement[];
    /** True when the element has a `{ ... }` body. */
    hasBody: boolean;
}

export interface VcmParseError {
    message: string;
    span: Span;
}

export interface VcmDocument {
    elements: VcmElement[];
    errors: VcmParseError[];
}

const isWhitespace = (c: string) =>
    c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f";
const isIdentifierStart = (c: string) =>
    (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isIdentifierPart = (c: string) =>
    isIdentifierStart(c) || (c >= "0" && c <= "9") || c === "-";

class Parser {
    pos = 0;
    errors: VcmParseError[] = [];

    constructor(readonly src: string) {}

    hasNext() {
        return this.pos < this.src.length;
    }

    skipWhitespace() {
        while (this.hasNext()) {
            const c = this.src[this.pos];
            if (isWhitespace(c)) {
                this.pos++;
            } else if (c === "#") {
                while (this.hasNext() && this.src[this.pos] !== "\n") {
                    this.pos++;
                }
            } else {
                break;
            }
        }
    }

    /** Like `BasicParser::peek`: skips whitespace and comments first. */
    peek(): string | undefined {
        this.skipWhitespace();
        return this.hasNext() ? this.src[this.pos] : undefined;
    }

    error(message: string, start = this.pos, end = start + 1) {
        this.errors.push({
            message,
            span: { start, end: Math.min(Math.max(end, start + 1), this.src.length || 1) },
        });
    }

    parseName(): { name: string; span: Span } | undefined {
        const c = this.peek();
        if (c === undefined || !isIdentifierStart(c)) {
            return undefined;
        }
        const start = this.pos;
        while (this.hasNext() && isIdentifierPart(this.src[this.pos])) {
            this.pos++;
        }
        return { name: this.src.slice(start, this.pos), span: { start, end: this.pos } };
    }

    parseValue(): Omit<VcmAttribute, "name" | "nameSpan"> {
        const start = this.pos;
        const c = this.src[this.pos];
        if (c === '"' || c === "'") {
            this.pos++;
            let text = "";
            while (this.hasNext() && this.src[this.pos] !== c) {
                const ch = this.src[this.pos];
                if (ch === "\\" && this.pos + 1 < this.src.length) {
                    const esc = this.src[this.pos + 1];
                    text += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
                    this.pos += 2;
                    continue;
                }
                if (ch === "\n") {
                    this.error("unexpected end of line in string", start, this.pos);
                    break;
                }
                text += ch;
                this.pos++;
            }
            if (this.src[this.pos] === c) {
                this.pos++;
            } else if (!this.hasNext()) {
                this.error("unclosed string", start, this.pos);
            }
            return { value: text, valueSpan: { start, end: this.pos }, kind: "string" };
        }
        if (c === "(") {
            this.pos++;
            let depth = 1;
            const inner = this.pos;
            while (this.hasNext()) {
                const ch = this.src[this.pos++];
                if (ch === "(") depth++;
                else if (ch === ")" && --depth === 0) break;
            }
            if (depth !== 0) {
                this.error("')' expected", start, this.pos);
                return { value: this.src.slice(inner, this.pos), valueSpan: { start, end: this.pos }, kind: "group" };
            }
            return {
                value: this.src.slice(inner, this.pos - 1),
                valueSpan: { start, end: this.pos },
                kind: "group",
            };
        }
        while (this.hasNext() && !isWhitespace(this.src[this.pos])) {
            this.pos++;
        }
        return { value: this.src.slice(start, this.pos), valueSpan: { start, end: this.pos }, kind: "word" };
    }

    /** Skip to the next '@', '{' or '}' after an error. */
    recover() {
        while (this.hasNext()) {
            const c = this.src[this.pos];
            if (c === "@" || c === "}" || c === "{") return;
            this.pos++;
        }
    }

    parseElements(nested: boolean): VcmElement[] {
        const elements: VcmElement[] = [];
        while (true) {
            const c = this.peek();
            if (c === undefined) {
                return elements;
            }
            if (c === "}") {
                if (!nested) {
                    this.error("unexpected '}'");
                    this.pos++;
                    continue;
                }
                return elements;
            }
            if (c !== "@") {
                this.error("unexpected character in element");
                this.pos++;
                this.recover();
                continue;
            }
            const start = this.pos;
            this.pos++;
            const name = this.parseName();
            if (!name) {
                this.error("identifier expected", this.pos);
                this.recover();
                continue;
            }
            const element: VcmElement = {
                tag: name.name,
                tagSpan: { start, end: name.span.end },
                span: { start, end: name.span.end },
                attributes: [],
                children: [],
                hasBody: false,
            };
            elements.push(element);
            while (true) {
                const p = this.peek();
                if (p === undefined || p === "@" || p === "{" || p === "}") break;
                const attrName = this.parseName();
                if (!attrName) {
                    this.error("identifier expected");
                    this.pos++;
                    this.recover();
                    break;
                }
                if (this.peek() === undefined) {
                    this.error(`value expected for '${attrName.name}'`, attrName.span.start, attrName.span.end);
                    element.span.end = this.pos;
                    break;
                }
                const value = this.parseValue();
                element.attributes.push({ name: attrName.name, nameSpan: attrName.span, ...value });
                element.span.end = this.pos;
            }
            if (this.peek() === "{") {
                const open = this.pos;
                this.pos++;
                element.hasBody = true;
                element.children = this.parseElements(true);
                if (this.peek() === "}") {
                    this.pos++;
                } else {
                    this.error("'}' expected", open, open + 1);
                }
                element.span.end = this.pos;
            }
        }
    }
}

export function parseVcm(source: string): VcmDocument {
    const parser = new Parser(source);
    const elements = parser.parseElements(false);
    return { elements, errors: parser.errors };
}

/** Parses "a, b, c" the way the engine's `xml::Attribute::asNumbers` does. */
export function parseNumbers(text: string): number[] | undefined {
    const parts = text.split(",").map((s) => s.trim());
    const result: number[] = [];
    for (const part of parts) {
        if (part === "") return undefined;
        const n = Number(part);
        if (!Number.isFinite(n)) return undefined;
        result.push(n);
    }
    return result;
}

export function getAttribute(element: VcmElement, name: string): VcmAttribute | undefined {
    return element.attributes.find((a) => a.name === name);
}

/** Visits every element depth-first. */
export function walkVcm(
    elements: VcmElement[],
    visit: (element: VcmElement, parent: VcmElement | undefined) => void,
    parent?: VcmElement
) {
    for (const element of elements) {
        visit(element, parent);
        walkVcm(element.children, visit, element);
    }
}
