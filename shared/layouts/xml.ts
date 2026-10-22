// XML parser for UI layouts. A port of the engine's `xml::parse`
// (src/coders/xml.cpp) on top of `BasicParser` (src/coders/BasicParser.inl),
// with source offsets. The first error is exactly the one the engine throws
// (checked against `xml.parse` in a headless engine); after it the parser
// recovers so editors still get a tree. Engine behaviour kept on purpose:
// - `peek()` skips whitespace, so `< panel >` and `</panel >` are fine, and
//   text nodes start at the first non-space character;
// - attribute values and text go through `parseString` (`\n`, `\t`, `\uXXXX`,
//   octal escapes; any other `\x` is an error; a newline inside a quoted value
//   is "non-closed string literal") and then `&quot; &apos; &lt; &gt; &amp;`;
// - an attribute without `=` has an empty value; a repeated one replaces the
//   earlier value; only `<!--` comments are allowed (`<![CDATA[` fails);
// - nothing after the root element is read.

export interface Span {
    start: number;
    end: number;
}

export interface XmlAttribute {
    name: string;
    nameSpan: Span;
    /** Decoded value ("" without `= "..."`). */
    value: string;
    /** Raw value between the quotes; undefined without `=`. */
    valueSpan?: Span;
    quote?: '"' | "'";
    /** From the name to the closing quote. */
    span: Span;
}

export interface XmlElement {
    type: "element";
    tag: string;
    tagSpan: Span;
    /** `<` to the end of the closing tag (or where recovery stopped). */
    span: Span;
    /** After the `>` / `/>` of the start tag; undefined if the start tag isn't closed. */
    startTagEnd?: number;
    closeTagSpan?: Span;
    selfClosing: boolean;
    attributes: XmlAttribute[];
    children: XmlNode[];
}

export interface XmlText {
    type: "text";
    /** Decoded text (not trimmed, like the engine). */
    value: string;
    span: Span;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlError {
    message: string;
    /** What to highlight. */
    span: Span;
    /** The engine's position for the message (often just after the culprit). */
    pos: number;
}

export interface XmlDocument {
    root?: XmlNode;
    /** The first one is what the engine reports; the rest come from recovery. */
    errors: XmlError[];
}

class ParseError extends Error {
    constructor(message: string, readonly pos: number, readonly from?: number) {
        super(message);
    }
}

const isWhitespace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f";
const isIdentifierStart = (c: string) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isXmlNameStart = (c: string) => isIdentifierStart(c) || c === ":";
const isXmlNamePart = (c: string) => isIdentifierStart(c) || isDigit(c) || c === "-" || c === "." || c === ":";
const hexValue = (c: string | undefined) => (c && /^[0-9a-fA-F]$/.test(c) ? parseInt(c, 16) : -1);

const SIMPLE_ESCAPES: Record<string, string> = {
    n: "\n", r: "\r", b: "\b", t: "\t", f: "\f", v: "\v", "'": "'", '"': '"', "\\": "\\", "/": "/",
};

/** `processEscapes` in xml.cpp: these five, in this order. */
function processEntities(text: string): string {
    return text.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** BasicParser's cursor primitives over a source string. */
class Cursor {
    pos = 0;
    constructor(readonly source: string) {}

    hasNext() {
        return this.pos < this.source.length;
    }
    skipWhitespace() {
        while (this.pos < this.source.length && isWhitespace(this.source[this.pos])) this.pos++;
    }
    peek(): string {
        this.skipWhitespace();
        if (this.pos >= this.source.length) throw new ParseError("unexpected end", this.pos);
        return this.source[this.pos];
    }
    nextChar(): string {
        if (!this.hasNext()) throw new ParseError("unexpected end", this.pos);
        return this.source[this.pos++];
    }
    expectChar(c: string) {
        if (this.peek() !== c) throw new ParseError(`'${c}' expected`, this.pos);
        this.pos++;
    }
    expectString(s: string) {
        for (let i = 0; i < s.length; i++) {
            if (this.source[this.pos + i] !== s[i]) throw new ParseError(`"${s}" expected`, this.pos);
        }
        this.pos += s.length;
    }
    isNext(s: string) {
        return s.length > 0 && this.source.startsWith(s, this.pos);
    }

    parseSimpleInt(base: number, maxLength = Infinity): number {
        const start = this.pos;
        let index = hexValue(this.peek());
        if (index === -1 || index >= base) throw new ParseError("invalid number literal", this.pos);
        let value = index;
        this.pos++;
        while (this.hasNext() && this.pos - start < maxLength) {
            while (this.source[this.pos] === "_") this.pos++;
            index = hexValue(this.source[this.pos]);
            if (index === -1 || index >= base) return value;
            value = value * base + index;
            this.pos++;
        }
        return value;
    }

    /** BasicParser::parseString. `quote` "" = no closing quote (inner text). */
    parseString(quote: string, closeRequired: boolean): string {
        let out = "";
        while (this.hasNext()) {
            let c = this.source[this.pos];
            if (c === quote) {
                this.pos++;
                return out;
            }
            if (c === "\\") {
                this.pos++;
                c = this.nextChar();
                if (c >= "0" && c <= "7") {
                    this.pos--;
                    out += String.fromCharCode(this.parseSimpleInt(8) & 0xff);
                    continue;
                }
                if (c === "u" || c === "x") {
                    out += String.fromCodePoint(this.parseSimpleInt(16, c === "u" ? 4 : 2));
                    continue;
                }
                if (c === "\n") continue;
                if (c in SIMPLE_ESCAPES) {
                    out += SIMPLE_ESCAPES[c];
                    continue;
                }
                throw new ParseError(`'\\${c}' is an illegal escape`, this.pos, this.pos - 2);
            }
            if (c === "\n" && closeRequired) throw new ParseError("non-closed string literal", this.pos);
            out += c;
            this.pos++;
        }
        if (closeRequired) throw new ParseError("unexpected end", this.pos);
        return out;
    }
}

class Parser extends Cursor {
    readonly errors: XmlError[] = [];
    private readonly open: string[] = [];

    record(e: unknown) {
        if (!(e instanceof ParseError)) throw e;
        const at = Math.min(e.pos, this.source.length);
        // with `from` the span is from..pos (an escape), else the character at pos
        const span = e.from !== undefined ? { start: e.from, end: at } : { start: at, end: Math.min(at + 1, this.source.length) };
        this.errors.push({ message: e.message, pos: at, span });
    }

    parseXmlName(): { name: string; span: Span } {
        const c = this.peek();
        if (!isXmlNameStart(c)) throw new ParseError("identifier expected", this.pos);
        const start = this.pos;
        while (this.hasNext() && isXmlNamePart(this.source[this.pos])) this.pos++;
        return { name: this.source.slice(start, this.pos), span: { start, end: this.pos } };
    }

    /** Skips the rest of a broken start tag: to the next `>` (consumed) or `<` (not). */
    private skipBrokenTag(): boolean {
        while (this.hasNext()) {
            const c = this.source[this.pos];
            if (c === "<") return false;
            this.pos++;
            if (c === ">") return true;
        }
        return false;
    }

    parseOpenTag(start: number): XmlElement {
        const { name, span } = this.parseXmlName();
        const element: XmlElement = { type: "element", tag: name, tagSpan: span, span: { start, end: span.end }, selfClosing: false, attributes: [], children: [] };
        for (;;) {
            this.skipWhitespace();
            const c = this.peek();
            if (c === "/" || c === ">" || c === "?") break;
            const attrName = this.parseXmlName();
            const attr: XmlAttribute = { name: attrName.name, nameSpan: attrName.span, value: "", span: { ...attrName.span } };
            this.skipWhitespace();
            if (this.peek() === "=") {
                this.nextChar();
                this.skipWhitespace();
                const quote = this.peek();
                if (quote !== "'" && quote !== '"') {
                    element.attributes.push(attr);
                    throw new ParseError("string literal expected", this.pos);
                }
                this.pos++;
                const valueStart = this.pos;
                attr.quote = quote;
                attr.valueSpan = { start: valueStart, end: valueStart };
                element.attributes.push(attr);
                attr.value = processEntities(this.parseString(quote, true));
                attr.valueSpan.end = this.pos - 1;
                attr.span.end = this.pos;
                continue;
            }
            element.attributes.push(attr);
        }
        return element;
    }

    parseText(): XmlText {
        const start = this.pos;
        while (this.hasNext()) {
            if (this.peek() === "<") break;
            this.nextChar();
        }
        const end = this.pos;
        // a separate Parser("[string]", text).parseString('\0', false): errors are relative to the text
        const sub = new Cursor(this.source.slice(start, end));
        try {
            return { type: "text", value: processEntities(sub.parseString("\0", false)), span: { start, end } };
        } catch (e) {
            if (e instanceof ParseError) throw new ParseError(e.message, start + e.pos, e.from === undefined ? undefined : start + e.from);
            throw e;
        }
    }

    parseComment() {
        this.expectString("!--");
        const close = this.source.indexOf("-->", this.pos);
        if (close < 0) {
            this.pos = this.source.length;
            throw new ParseError("comment close missing", this.pos);
        }
        this.pos = close + 3;
    }

    /** null for a comment. */
    parseElement(): XmlNode | null {
        if (this.peek() !== "<") return this.parseText();
        const start = this.pos;
        this.nextChar();
        if (this.peek() === "!") {
            if (this.isNext("!DOCTYPE ")) throw new ParseError("XML DTD is not supported yet", this.pos);
            this.parseComment();
            return null;
        }
        let element: XmlElement;
        try {
            element = this.parseOpenTag(start);
        } catch (e) {
            // a start tag we couldn't finish: keep what we have, as an empty element
            this.record(e);
            const partial = this.recoverOpenTag(start);
            if (!partial) return null;
            return partial;
        }
        const c = this.nextChar();
        if (c === "/") {
            element.selfClosing = true;
            this.expectChar(">");
            element.startTagEnd = element.span.end = this.pos;
            return element;
        }
        if (c !== ">") throw new ParseError("invalid syntax", this.pos - 1);
        element.startTagEnd = this.pos;
        this.open.push(element.tag);
        try {
            this.parseChildren(element);
        } finally {
            this.open.pop();
        }
        return element;
    }

    /** Re-parses a broken start tag leniently (after its error was recorded). */
    private recoverOpenTag(start: number): XmlElement | null {
        this.pos = start + 1;
        this.skipWhitespace();
        const nameStart = this.pos;
        while (this.hasNext() && isXmlNamePart(this.source[this.pos])) this.pos++;
        if (this.pos === nameStart) {
            this.skipBrokenTag();
            return null;
        }
        const element: XmlElement = {
            type: "element", tag: this.source.slice(nameStart, this.pos), tagSpan: { start: nameStart, end: this.pos },
            span: { start, end: this.pos }, selfClosing: true, attributes: [], children: [],
        };
        // attributes as far as they look like name="value"
        const re = /\s*([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'))?/y;
        for (;;) {
            re.lastIndex = this.pos;
            const m = re.exec(this.source);
            if (!m || m[0].trim() === "") break;
            const nameAt = this.pos + m[0].indexOf(m[1]);
            const value = m[2] ?? m[3];
            const attr: XmlAttribute = { name: m[1], nameSpan: { start: nameAt, end: nameAt + m[1].length }, value: value ?? "", span: { start: nameAt, end: this.pos + m[0].length } };
            if (value !== undefined) {
                attr.quote = m[2] !== undefined ? '"' : "'";
                attr.valueSpan = { start: this.pos + m[0].length - 1 - value.length, end: this.pos + m[0].length - 1 };
                attr.value = processEntities(value);
            }
            element.attributes.push(attr);
            this.pos += m[0].length;
        }
        const closed = this.skipBrokenTag();
        element.span.end = this.pos;
        if (closed) {
            element.startTagEnd = this.pos;
            if (this.source[this.pos - 2] !== "/") {
                // an open element: read its children like a normal one
                element.selfClosing = false;
                this.open.push(element.tag);
                try {
                    this.parseChildren(element);
                } catch (e) {
                    this.record(e);
                } finally {
                    this.open.pop();
                }
            }
        }
        return element;
    }

    private parseChildren(element: XmlElement) {
        this.skipWhitespace();
        while (!this.isNext("</")) {
            if (!this.hasNext()) {
                this.record(new ParseError("unexpected end", this.pos));
                element.span.end = this.pos;
                return;
            }
            const before = this.pos;
            try {
                const sub = this.parseElement();
                if (sub) element.children.push(sub);
            } catch (e) {
                this.record(e);
                if (this.pos <= before) this.pos = before + 1;
                // resynchronize at the next tag
                while (this.hasNext() && this.source[this.pos] !== "<") this.pos++;
            }
            this.skipWhitespace();
        }
        const closeStart = this.pos;
        this.pos += 2;
        const nameStart = this.pos;
        try {
            // `</panelx>` passes this (only the tag's length is compared) and fails at '>'
            this.expectString(element.tag);
            this.expectChar(">");
            element.closeTagSpan = { start: closeStart, end: this.pos };
            element.span.end = this.pos;
        } catch (e) {
            this.record(e);
            let end = nameStart;
            while (end < this.source.length && isXmlNamePart(this.source[end])) end++;
            const name = this.source.slice(nameStart, end);
            if (this.open.slice(0, -1).includes(name)) {
                // it closes an outer element: leave it for that one
                this.pos = closeStart;
                element.span.end = closeStart;
                return;
            }
            // a stray close tag: skip it and keep reading children
            this.pos = end;
            this.skipBrokenTag();
            this.parseChildren(element);
        }
    }

    parseDocument(): XmlNode | undefined {
        // parseDeclaration
        this.expectChar("<");
        if (this.peek() === "?") {
            this.nextChar();
            const node = this.parseOpenTag(this.pos - 2);
            this.expectString("?>");
            if (node.tag !== "xml") throw new ParseError("invalid declaration", this.pos);
            const encoding = node.attributes.filter((a) => a.name === "encoding").pop()?.value ?? "UTF-8";
            if (encoding !== "utf-8" && encoding !== "UTF-8") throw new ParseError("UTF-8 encoding is only supported", this.pos);
        } else {
            // goBack(): one character back from where peek() stopped, which is
            // the '<' only when nothing was skipped
            this.pos--;
        }
        let root: XmlNode | null = null;
        while (root === null) root = this.parseElement();
        return root;
    }
}

export function parseLayoutXml(source: string): XmlDocument {
    const parser = new Parser(source);
    let root: XmlNode | undefined;
    try {
        root = parser.parseDocument();
    } catch (e) {
        parser.record(e);
    }
    return { root, errors: parser.errors };
}

/** Elements in document order, with their parent. */
export function* walkElements(node: XmlNode | undefined, parent?: XmlElement): Generator<{ element: XmlElement; parent?: XmlElement }> {
    if (!node || node.type !== "element") return;
    yield { element: node, parent };
    for (const child of node.children) yield* walkElements(child, node);
}

// ---------------------------------------------------------------- editing context

export type LayoutContext =
    | { kind: "tag"; parent?: string; start: number }
    | { kind: "closeTag"; open?: string; start: number }
    | { kind: "attribute"; tag: string; start: number; present: string[] }
    | { kind: "value"; tag: string; attribute: string; start: number; quote: string }
    | { kind: "none" };

/**
 * What is being typed at `offset`. A forgiving scan (half-typed markup is
 * the normal case here), independent of the engine-exact parser.
 */
export function layoutContextAt(text: string, offset: number): LayoutContext {
    const stack: string[] = [];
    let i = 0;
    while (i < offset) {
        if (text.startsWith("<!--", i)) {
            const close = text.indexOf("-->", i + 4);
            if (close < 0 || close + 3 > offset) return { kind: "none" };
            i = close + 3;
            continue;
        }
        if (text[i] !== "<") {
            i++;
            continue;
        }
        // a tag starts at i
        const tagStart = i;
        let j = i + 1;
        const closing = text[j] === "/";
        if (closing) j++;
        while (j < offset && isWhitespace(text[j])) j++;
        const nameStart = j;
        while (j < text.length && isXmlNamePart(text[j])) j++;
        const name = text.slice(nameStart, j);
        if (j >= offset) {
            // the cursor is in the tag name
            return closing ? { kind: "closeTag", open: stack[stack.length - 1], start: nameStart } : { kind: "tag", parent: stack[stack.length - 1], start: nameStart };
        }
        // attributes up to '>' or the cursor
        const present: string[] = [];
        let k = j;
        for (;;) {
            while (k < text.length && k < offset && isWhitespace(text[k])) k++;
            if (k >= offset) return closing ? { kind: "none" } : { kind: "attribute", tag: name, start: offset, present };
            const c = text[k];
            if (c === ">" || (c === "/" && text[k + 1] === ">")) break;
            if (c === "<") break; // unterminated tag
            const attrStart = k;
            while (k < text.length && isXmlNamePart(text[k])) k++;
            const attr = text.slice(attrStart, k);
            if (k >= offset && attr) return { kind: "attribute", tag: name, start: attrStart, present };
            if (!attr) {
                k++;
                continue;
            }
            present.push(attr);
            let e = k;
            while (e < text.length && e < offset && isWhitespace(text[e])) e++;
            if (text[e] !== "=") {
                k = e;
                continue;
            }
            e++;
            while (e < text.length && e < offset && isWhitespace(text[e])) e++;
            const q = text[e];
            if (q !== '"' && q !== "'") {
                k = e;
                continue;
            }
            const close = text.indexOf(q, e + 1);
            if (close < 0 || close >= offset) {
                // the cursor is inside this value (a newline ends a value, as in the engine)
                const nl = text.indexOf("\n", e + 1);
                if (nl >= 0 && nl < offset) return { kind: "none" };
                return { kind: "value", tag: name, attribute: attr, start: e + 1, quote: q };
            }
            k = close + 1;
        }
        if (k >= offset) return { kind: "none" };
        if (text[k] === "<") {
            i = k;
            continue;
        }
        const selfClosing = text[k] === "/";
        i = k + (selfClosing ? 2 : 1);
        if (closing) {
            const at = stack.lastIndexOf(name);
            if (at >= 0) stack.length = at;
        } else if (!selfClosing && name && text.slice(tagStart, tagStart + 2) !== "<?") {
            stack.push(name);
        }
    }
    return { kind: "none" };
}
