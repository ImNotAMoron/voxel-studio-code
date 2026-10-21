// Minimal TOML source locator: finds table headers, keys and string literals
// with offsets so diagnostics can point at exact ranges (smol-toml gives no
// positions).

export interface TomlToken {
    kind: "key" | "string" | "header";
    text: string;
    start: number;
    end: number;
    /** Enclosing `[table]` name ("" at top level). */
    section: string;
}

export class TomlLocator {
    readonly tokens: TomlToken[] = [];

    constructor(readonly text: string) {
        this.scan();
    }

    private scan() {
        const t = this.text;
        let section = "";
        let i = 0;
        let lineStart = true;
        let depth = 0; // [] / {} nesting inside values
        while (i < t.length) {
            const c = t[i];
            if (c === "\n") {
                lineStart = true;
                i++;
                continue;
            }
            if (c === " " || c === "\t" || c === "\r") {
                i++;
                continue;
            }
            if (c === "#") {
                while (i < t.length && t[i] !== "\n") i++;
                continue;
            }
            if (lineStart && depth === 0 && c === "[") {
                const close = t.indexOf("]", i);
                const lineEnd = t.indexOf("\n", i);
                const end = close < 0 || (lineEnd >= 0 && close > lineEnd) ? (lineEnd < 0 ? t.length : lineEnd) : close + 1;
                const inner = t.slice(i, end).replace(/^\[+|\]+$/g, "").trim();
                section = inner.replace(/^"(.*)"$/, "$1");
                this.tokens.push({ kind: "header", text: section, start: i, end, section });
                i = end;
                lineStart = false;
                continue;
            }
            lineStart = false;
            if (c === '"' || c === "'") {
                const start = i;
                const triple = t.startsWith(c.repeat(3), i);
                let value = "";
                if (triple) {
                    const close = t.indexOf(c.repeat(3), i + 3);
                    const end = close < 0 ? t.length : close + 3;
                    value = t.slice(i + 3, close < 0 ? t.length : close);
                    i = end;
                } else {
                    i++;
                    while (i < t.length && t[i] !== c && t[i] !== "\n") {
                        if (c === '"' && t[i] === "\\") {
                            value += t[i + 1] ?? "";
                            i += 2;
                            continue;
                        }
                        value += t[i];
                        i++;
                    }
                    if (t[i] === c) i++;
                }
                const kind = this.followedByEquals(i) ? "key" : "string";
                this.tokens.push({ kind, text: value, start, end: i, section });
                continue;
            }
            if (c === "[" || c === "{") {
                depth++;
                i++;
                continue;
            }
            if (c === "]" || c === "}") {
                depth = Math.max(0, depth - 1);
                i++;
                continue;
            }
            if (/[A-Za-z0-9_-]/.test(c)) {
                const start = i;
                while (i < t.length && /[A-Za-z0-9_.-]/.test(t[i])) i++;
                if (this.followedByEquals(i)) {
                    this.tokens.push({ kind: "key", text: t.slice(start, i), start, end: i, section });
                }
                continue;
            }
            i++;
        }
    }

    private followedByEquals(i: number): boolean {
        const t = this.text;
        while (i < t.length && (t[i] === " " || t[i] === "\t")) i++;
        return t[i] === "=";
    }

    header(section: string): TomlToken | undefined {
        return this.tokens.find((t) => t.kind === "header" && t.text === section);
    }

    keys(section: string, key: string): TomlToken[] {
        return this.tokens.filter((t) => t.kind === "key" && t.section === section && t.text === key);
    }

    strings(section: string, value: string): TomlToken[] {
        return this.tokens.filter((t) => t.kind === "string" && t.section === section && t.text === value);
    }

    /** Raw value text after `key =` up to `,` `}` `]` or end of line. */
    rawValueAfter(token: TomlToken): string {
        const rest = this.text.slice(token.end);
        const m = /^\s*=\s*([^,}\]\n#]*)/.exec(rest);
        return m ? m[1].trim() : "";
    }

    /** Range of a top-level/section key, or of the section header, or [0, 0]. */
    keyRange(section: string, key: string): [number, number] {
        const token = this.keys(section, key)[0] ?? this.header(section);
        return token ? [token.start, token.end] : [0, 0];
    }
}
