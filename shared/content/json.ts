// Shared JSON helpers.

/**
 * The engine JSON parser (src/coders/json.cpp) accepts trailing commas and
 * `#` line comments inside objects/lists. Blank `#` comments out (keeping
 * offsets) so jsonc-parser sees the same document.
 */
export function sanitizeJson(text: string): string {
    if (!text.includes("#")) return text;
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === "\\") {
                out += c + (text[i + 1] ?? "");
                i++;
                continue;
            }
            if (c === '"') inString = false;
            out += c;
        } else if (c === '"') {
            inString = true;
            out += c;
        } else if (c === "#") {
            while (i < text.length && text[i] !== "\n") {
                out += text[i] === "\r" ? "\r" : " ";
                i++;
            }
            if (i < text.length) out += "\n";
        } else {
            out += c;
        }
    }
    return out;
}
