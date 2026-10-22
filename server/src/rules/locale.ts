// Rules for locale files `texts/<lang>.txt` (FEATURES.md §3.6).

import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex, UnitDef, closest } from "../../../shared/content/index";
import { engineLanguages, idToCaption, parseLocale, readLocaleFile, translations } from "../../../shared/content/locale";
import { FileContext } from "./context";

export interface LocaleStub {
    key: string;
    value: string;
}

/** Units the engine shows with a caption: visible blocks, items (block items share the block's caption). */
export function captionKeys(index: ContentIndex, pack: string): Map<string, string> {
    const keys = new Map<string, string>(); // key → unit id
    const add = (unit: UnitDef, key: unknown) => {
        if (typeof key === "string" && key && !keys.has(key)) keys.set(key, unit.id);
    };
    for (const unit of index.blocks.values()) {
        if (unit.pack !== pack || unit.generated || index.blockProperty(unit, "hidden") === true) continue;
        const caption = index.blockProperty(unit, "caption");
        add(unit, typeof caption === "string" ? caption : idToCaption(unit.id));
    }
    for (const unit of index.items.values()) {
        if (unit.pack !== pack || unit.generated) continue;
        const caption = index.blockProperty(unit, "caption");
        add(unit, typeof caption === "string" ? caption : idToCaption(unit.id));
        add(unit, index.blockProperty(unit, "description"));
    }
    return keys;
}

/** Other language files of the same pack. */
function siblings(ctx: FileContext): { lang: string; file: string }[] {
    const dir = path.dirname(ctx.file);
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith(".txt") && path.join(dir, f) !== ctx.file)
            .map((f) => ({ lang: f.slice(0, -4), file: path.join(dir, f) }));
    } catch {
        return [];
    }
}

const LIST = 8;
const list = (keys: string[]) => keys.slice(0, LIST).map((k) => `'${k}'`).join(", ") + (keys.length > LIST ? `, … (${keys.length} total)` : "");

export function lintLocale(ctx: FileContext) {
    const { report, text, index } = ctx;
    const lang = path.basename(ctx.file, ".txt");
    const parsed = parseLocale(text);
    if (parsed.error) {
        // checked with a real run: the content load fails, the world doesn't open,
        // and the engine's message doesn't name this file
        report.add("VC0300", parsed.error.start, parsed.error.end,
            `${parsed.error.message}: while ${lang} (or the fallback language) is selected, loading content fails with this error and the world doesn't open`,
            { severity: "error" });
    }
    // duplicates: the last one wins
    const last = new Map<string, number>();
    parsed.entries.forEach((e, i) => last.set(e.key, i));
    parsed.entries.forEach((e, i) => {
        const winner = last.get(e.key)!;
        if (winner !== i) {
            report.add("VC0301", e.keyStart, e.keyEnd, `duplicate key '${e.key}': line ${parsed.entries[winner].line + 1} overrides this value`, { tags: ["unnecessary"] });
        }
    });
    const engine = engineLanguages(index.resPath);
    if (engine && !engine.langs.has(lang)) {
        const suggestion = closest(lang, engine.langs);
        report.add("VC0302", 0, 0,
            `'${lang}' isn't a language of the engine (res/texts/langs.json), so this file is never loaded` +
            (suggestion ? `; did you mean '${suggestion}.txt'?` : ""));
        return;
    }
    // the fallback language shows missing keys as the key itself (captions are English already)
    if (engine && lang === engine.fallback) return;
    const own = new Set(parsed.entries.map((e) => e.key));
    const reference = new Map<string, string>(); // key → value for the stub
    const fallbackFile = engine ? siblings(ctx).find((s) => s.lang === engine.fallback) : undefined;
    const fallbackValues = new Map((fallbackFile ? readLocaleFile(fallbackFile.file)?.entries ?? [] : []).map((e) => [e.key, e.value]));
    const missing: string[] = [];
    for (const sibling of siblings(ctx)) {
        if (sibling.lang === engine?.fallback || (engine && !engine.langs.has(sibling.lang))) continue;
        for (const e of readLocaleFile(sibling.file)?.entries ?? []) {
            if (own.has(e.key) || reference.has(e.key)) continue;
            reference.set(e.key, fallbackValues.get(e.key) ?? e.key);
            missing.push(e.key);
        }
    }
    if (missing.length) {
        report.add("VC0303", 0, 0, `${missing.length} key(s) of the pack's other languages are missing here: ${list(missing)}`, {
            data: { stubs: missing.map((key) => ({ key, value: reference.get(key)! })) },
        });
    }
    // captions of the pack's units without a translation in this language (from any pack)
    const untranslated: string[] = [];
    for (const key of captionKeys(index, ctx.pack.id).keys()) {
        if (own.has(key) || reference.has(key)) continue;
        if (translations(index, key).some((t) => t.lang === lang)) continue;
        untranslated.push(key);
    }
    if (untranslated.length) {
        report.add("VC0304", 0, 0, `${untranslated.length} caption(s) of this pack's blocks and items have no ${lang} translation: ${list(untranslated)}`, {
            data: { stubs: untranslated.map((key) => ({ key, value: fallbackValues.get(key) ?? key })) },
        });
    }
}
