// Attribute value checks for XML UI layouts: models of how the engine reads
// each value type (src/coders/xml.cpp `Attribute::as*`, util::parse_double,
// std::stoll), so a value is flagged exactly when the engine throws (the
// layout fails to load) or silently reads something other than what's written.

import type { LayoutAttribute } from "./index";

export interface ValueProblem {
    /** `throws`: the layout fails to load; `misread`: read differently; `unknown`: not one of the values. */
    kind: "throws" | "misread" | "unknown";
    message: string;
    /** Offsets inside the value (default: the whole value). */
    start?: number;
    end?: number;
    suggestion?: string;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";

/** Prefix that std::from_chars (chars_format::general) accepts for a double. */
const FLOAT_PREFIX = /^-?(?:inf(?:inity)?|nan(?:\([\w]*\))?|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/i;

interface NumberRead {
    value?: number;
    /** Characters after the number (from_chars stops there silently). */
    rest: string;
    /** Offset of `rest` in the input. */
    restAt: number;
}

/** util::parse_double: leading spaces, one optional '+', then from_chars on the prefix. */
export function readDouble(text: string): NumberRead {
    let i = 0;
    while (i < text.length && isSpace(text[i])) i++;
    if (text[i] === "+") i++;
    const m = FLOAT_PREFIX.exec(text.slice(i));
    if (!m) return { rest: text.slice(i), restAt: i };
    const raw = m[0].toLowerCase().replace(/\(.*\)$/, "");
    const value = raw.includes("nan") ? NaN : raw.includes("inf") ? (raw.startsWith("-") ? -Infinity : Infinity) : Number(raw);
    return { value, rest: text.slice(i + m[0].length), restAt: i + m[0].length };
}

/** std::stoll (base 10) then the int cast of Attribute::asInt. */
export function readInt(text: string): NumberRead & { outOfRange?: boolean } {
    let i = 0;
    while (i < text.length && isSpace(text[i])) i++;
    const m = /^[-+]?\d+/.exec(text.slice(i));
    if (!m) return { rest: text.slice(i), restAt: i };
    const big = BigInt(m[0]);
    const outOfRange = big > 9223372036854775807n || big < -9223372036854775808n;
    return { value: Number(BigInt.asIntN(32, big)), rest: text.slice(i + m[0].length), restAt: i + m[0].length, outOfRange };
}

const COMPONENTS: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };

/** Attribute::asVec2/3/4: no comma = one number for all; otherwise exactly n-1 commas are looked for. */
function checkVector(text: string, n: number, what: string): ValueProblem | undefined {
    const commas: number[] = [];
    for (let i = 0; i < text.length && commas.length < n - 1; i++) if (text[i] === ",") commas.push(i);
    if (commas.length > 0 && commas.length < n - 1) {
        return { kind: "throws", message: `invalid vec${n} value: needs ${n} numbers (or one for all)` };
    }
    const bounds = commas.length ? [-1, ...commas, text.length] : [-1, text.length];
    for (let k = 0; k + 1 < bounds.length; k++) {
        const start = bounds[k] + 1;
        const part = text.slice(start, bounds[k + 1]);
        const read = readDouble(part);
        if (read.value === undefined) {
            const shown = part.trim() ? `'${part.trim()}' isn't a number` : n > 1 && commas.length ? `component ${k + 1} is empty` : "an empty value isn't a number";
            return { kind: "throws", message: `${shown} (invalid number format)`, start, end: start + part.length };
        }
        if (read.rest.trim()) {
            const last = k + 2 === bounds.length;
            const extra = read.rest.trimStart();
            const at = start + read.restAt + (read.rest.length - extra.length);
            const message = last && commas.length && extra.startsWith(",")
                ? `more than ${n} numbers: the engine ignores '${extra.replace(/^,\s*/, "")}'`
                : !commas.length && /^[\s,]*[-+.\d]/.test(read.rest)
                    ? `read as ${what} ${read.value} for all components: separate the numbers with commas`
                    : `'${extra}' after the number is ignored`;
            return { kind: "misread", message, start: at, end: start + part.length };
        }
    }
    return undefined;
}

function checkColor(text: string): ValueProblem | undefined {
    if (text[0] === "#") {
        if (text.length !== 7 && text.length !== 9) return { kind: "throws", message: "#RRGGBB or #RRGGBBAA required" };
        const bad = [...text.slice(1)].findIndex((c) => !/[0-9a-fA-F]/.test(c));
        if (bad >= 0) {
            return { kind: "misread", message: `'${text[bad + 1]}' isn't a hex digit: the engine reads it as -1, so the colour comes out wrong`, start: bad + 1, end: bad + 2 };
        }
        return undefined;
    }
    const vector = checkVector(text, 4, "color");
    if (vector) return vector.kind === "throws" && /vec4/.test(vector.message)
        ? { ...vector, message: "a numeric colour needs r,g,b,a (0–255), or use #RRGGBB" }
        : vector;
    return undefined;
}

function checkBool(text: string): ValueProblem | undefined {
    if (text === "true" || text === "1" || text === "false" || text === "0") return undefined;
    if (text === "") return { kind: "misread", message: "without a value this is false (only 'true' and '1' are true)", suggestion: "true" };
    return { kind: "misread", message: `'${text}' counts as false: only 'true' and '1' are true`, suggestion: /^(yes|on|True|TRUE)$/.test(text) ? "true" : undefined };
}

function checkInt(text: string): ValueProblem | undefined {
    const read = readInt(text);
    if (read.value === undefined) return { kind: "throws", message: `${text.trim() ? `'${text}' isn't` : "an empty value isn't"} an integer (std::stoll throws)` };
    if (read.outOfRange) return { kind: "throws", message: `'${text}' is out of range (std::stoll throws)` };
    if (read.rest.trim()) return { kind: "misread", message: `read as ${read.value}: '${read.rest.trim()}' is ignored`, start: read.restAt, end: text.length };
    return undefined;
}

function checkNumber(text: string): ValueProblem | undefined {
    const read = readDouble(text);
    if (read.value === undefined) return { kind: "throws", message: `${text.trim() ? `'${text}' isn't` : "an empty value isn't"} a number (invalid number format)` };
    if (read.rest.trim()) return { kind: "misread", message: `read as ${read.value}: '${read.rest.trim()}' is ignored`, start: read.restAt, end: text.length };
    return undefined;
}

/** What the engine does with a value that isn't in the list (gui_xml.cpp and the elements). */
const UNKNOWN_EFFECT: Record<string, string> = {
    orientation: "anything but 'horizontal' is vertical",
    mode: "anything but 'button' is the select mode",
    gravity: "no automatic positioning",
    align: "the alignment stays the default",
    "text-align": "the alignment stays the default",
    valign: "the alignment stays the default",
    cursor: "the cursor isn't changed",
    markup: "the text is shown as is",
    syntax: "no highlighting (a file extension from res/devtools/syntax)",
};

function levenshtein(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cur = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
    }
    return row[b.length];
}

function closestValue(value: string, values: string[]): string | undefined {
    const lower = values.find((v) => v.toLowerCase() === value.toLowerCase());
    if (lower) return lower;
    let best: string | undefined;
    let bestDistance = Math.max(2, Math.floor(value.length / 3)) + 1;
    for (const v of values) {
        const d = levenshtein(value, v);
        if (d < bestDistance) {
            best = v;
            bestDistance = d;
        }
    }
    return best;
}

/** Checks one attribute value; `name` is the attribute name. */
export function checkLayoutValue(name: string, attr: LayoutAttribute, value: string): ValueProblem | undefined {
    if (value.includes("%{")) return undefined; // a template placeholder (gui.template)
    switch (attr.type) {
        case "vec2": case "vec3": case "vec4":
            return checkVector(value, COMPONENTS[attr.type], attr.type);
        case "color":
            return checkColor(value);
        case "bool":
            return checkBool(value);
        case "int":
            return checkInt(value);
        case "number":
            return checkNumber(value);
        case "enum": {
            const values = attr.values ?? [];
            if (values.includes(value)) return undefined;
            const suggestion = closestValue(value, values);
            const effect = UNKNOWN_EFFECT[name] ?? "the engine ignores it";
            return {
                kind: "unknown",
                message: `'${value}' isn't one of the ${name} values: ${effect}` + (suggestion ? ` (did you mean '${suggestion}'?)` : ""),
                suggestion,
            };
        }
        default:
            return undefined;
    }
}
