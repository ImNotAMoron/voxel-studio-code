// Locale files `texts/<lang>.txt` (FEATURES.md §3.6). A port of the engine's
// reader (src/frontend/locale.cpp Reader + BasicParser::parseString):
// - whitespace and `#` comment lines are skipped before each key;
// - the key runs to `=` (a newline first is "non-closed string literal");
// - the value runs to the end of the line;
// - both are trimmed and both process escapes (`\n`, `\t`, `\uXXXX`, octal,
//   `\` + newline continues the line; anything else is "illegal escape").
// Later keys overwrite earlier ones; packs are read after res/texts.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContentIndex } from "./index";

/** util::id_to_caption: the default caption (and locale key) of a unit. */
export function idToCaption(id: string): string {
    const colon = id.indexOf(":");
    if (colon < 0 || colon === id.length - 1) return "";
    const name = id.slice(colon + 1);
    const lead = /^_*/.exec(name)![0].length;
    return name.slice(0, lead) + name.slice(lead).replace(/_/g, " ");
}

export interface LocaleEntry {
    key: string;
    value: string;
    /** Offsets of the trimmed raw key and value. */
    keyStart: number;
    keyEnd: number;
    valueStart: number;
    valueEnd: number;
    /** 0-based line of the key. */
    line: number;
}

export interface LocaleComment {
    text: string;
    start: number;
    end: number;
    line: number;
}

export interface LocaleError {
    message: string;
    start: number;
    end: number;
}

export interface LocaleFile {
    entries: LocaleEntry[];
    comments: LocaleComment[];
    /** The engine stops at the first error and throws. */
    error?: LocaleError;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", b: "\b", t: "\t", f: "\f", v: "\v", "'": "'", '"': '"', "\\": "\\", "/": "/" };

class ParseError extends Error {
    constructor(message: string, readonly start: number, readonly end: number) {
        super(message);
    }
}

export function parseLocale(text: string): LocaleFile {
    const entries: LocaleEntry[] = [];
    const comments: LocaleComment[] = [];
    let pos = 0;
    const lineOf = (offset: number) => {
        let n = 0;
        for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
        return n;
    };
    const isSpace = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v";
    const skipWhitespace = () => {
        for (;;) {
            while (pos < text.length && isSpace(text[pos])) pos++;
            if (pos < text.length && text[pos] === "#") {
                const start = pos;
                while (pos < text.length && text[pos] !== "\n") pos++;
                comments.push({ text: text.slice(start, pos).replace(/\r$/, ""), start, end: pos, line: lineOf(start) });
                continue;
            }
            return;
        }
    };
    /** BasicParser::parseString; returns the decoded string and the raw end (before the terminator). */
    const parseString = (quote: string, closeRequired: boolean): { value: string; rawEnd: number } => {
        let out = "";
        while (pos < text.length) {
            const c = text[pos];
            if (c === quote) {
                const rawEnd = pos;
                pos++;
                return { value: out, rawEnd };
            }
            if (c === "\\") {
                const at = pos;
                pos++;
                const e = text[pos++] ?? "";
                if (e >= "0" && e <= "7") {
                    let digits = e;
                    while (pos < text.length && /[0-7]/.test(text[pos])) digits += text[pos++];
                    out += String.fromCharCode(parseInt(digits, 8) & 0xff);
                    continue;
                }
                if (e === "u" || e === "x") {
                    const n = e === "u" ? 4 : 2;
                    const hex = text.slice(pos, pos + n);
                    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) throw new ParseError(`invalid '\\${e}' escape`, at, pos + hex.length);
                    pos += n;
                    out += String.fromCodePoint(parseInt(hex, 16));
                    continue;
                }
                if (e === "\n") continue;
                if (e in SIMPLE_ESCAPES) {
                    out += SIMPLE_ESCAPES[e];
                    continue;
                }
                throw new ParseError(`'\\${e}' is an illegal escape`, at, pos);
            }
            if (c === "\n" && closeRequired) throw new ParseError("non-closed string literal (a line without '=')", lineStartOf(pos), pos);
            out += c;
            pos++;
        }
        if (closeRequired) throw new ParseError("unexpected end (a line without '=')", lineStartOf(pos), pos);
        return { value: out, rawEnd: pos };
    };
    const lineStartOf = (offset: number) => text.lastIndexOf("\n", offset - 1) + 1;
    const trimmed = (start: number, end: number) => {
        while (start < end && isSpace(text[start])) start++;
        while (end > start && isSpace(text[end - 1])) end--;
        return [start, end] as const;
    };
    try {
        skipWhitespace();
        while (pos < text.length) {
            const keyRawStart = pos;
            const key = parseString("=", true);
            const [keyStart, keyEnd] = trimmed(keyRawStart, key.rawEnd);
            const valueRawStart = pos;
            const value = parseString("\n", false);
            const [valueStart, valueEnd] = trimmed(valueRawStart, value.rawEnd);
            entries.push({ key: key.value.trim(), value: value.value.trim(), keyStart, keyEnd, valueStart, valueEnd, line: lineOf(keyStart) });
            skipWhitespace();
        }
    } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        return { entries, comments, error: { message: err.message, start: err.start, end: Math.max(err.end, err.start + 1) } };
    }
    return { entries, comments };
}

/** Languages the engine knows (`res/texts/langs.json` keys) and the fallback. */
export function engineLanguages(resPath: string | undefined): { langs: Set<string>; fallback: string } | undefined {
    if (!resPath) return undefined;
    try {
        const json = JSON.parse(fs.readFileSync(path.join(resPath, "texts", "langs.json"), "utf8"));
        return { langs: new Set(Object.keys(json.langs ?? {})), fallback: typeof json.fallback === "string" ? json.fallback : "en_US" };
    } catch {
        return undefined;
    }
}

/** Every language file of every indexed pack plus `res/texts`, parsed (cached by mtime). */
const cache = new Map<string, { stamp: string; parsed: LocaleFile }>();

export function readLocaleFile(file: string, text?: string): LocaleFile | undefined {
    if (text !== undefined) return parseLocale(text);
    try {
        const st = fs.statSync(file);
        const stamp = `${st.mtimeMs}:${st.size}`;
        const hit = cache.get(file);
        if (hit?.stamp === stamp) return hit.parsed;
        const parsed = parseLocale(fs.readFileSync(file, "utf8"));
        cache.set(file, { stamp, parsed });
        return parsed;
    } catch {
        return undefined;
    }
}

export interface Translation {
    lang: string;
    pack: string;
    value: string;
    file: string;
    line: number;
}

/**
 * Translations of `key` per language, in the engine's load order: the
 * engine's res/texts first, then each pack (later wins).
 */
export function translations(index: ContentIndex, key: string, readText?: (file: string) => string | undefined): Translation[] {
    const out: Translation[] = [];
    const sources: { pack: string; dir: string }[] = [];
    if (index.resPath) sources.push({ pack: "core", dir: path.join(index.resPath, "texts") });
    for (const pd of index.data.values()) {
        if (pd.info.id === "core") continue;
        sources.push({ pack: pd.info.id, dir: path.join(pd.info.root, "texts") });
    }
    for (const { pack, dir } of sources) {
        let files: string[];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"));
        } catch {
            continue;
        }
        for (const name of files) {
            const file = path.join(dir, name);
            const parsed = readLocaleFile(file, readText?.(file));
            const entry = parsed && [...parsed.entries].reverse().find((e) => e.key === key);
            if (entry) out.push({ lang: name.slice(0, -4), pack, value: entry.value, file, line: entry.line });
        }
    }
    return out;
}
