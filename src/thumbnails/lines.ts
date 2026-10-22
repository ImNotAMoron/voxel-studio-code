// Which line shows which texture in the gutter (FEATURES.md §3.9). Pure: the
// references come from the language server's extractor, so the icons match
// go-to-definition.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContentIndex } from "../../shared/content";
import { encodePng, decodePng, scaleNearest, thumbnailFactor } from "../../shared/assets/png";
import { extractRefs } from "../../server/src/features/references";
import { resolveRef } from "../../server/src/features/refs";

const TEXTURE_KINDS = new Set(["blockTexture", "atlasTexture", "itemIcon", "texturePath"]);

/** 0-based line → texture file (the first texture reference of the line). */
export function textureLines(index: ContentIndex, file: string, text: string): Map<number, string> {
    const fromPack = index.packForFile(file)?.id;
    const out = new Map<number, string>();
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const lineOf = (offset: number) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };
    for (const ref of extractRefs(index, file, text)) {
        if (!TEXTURE_KINDS.has(ref.kind)) continue;
        const line = lineOf(ref.start);
        if (out.has(line)) continue;
        const resolved = resolveRef(index, ref.kind, ref.value, fromPack);
        if (resolved && /\.png$/i.test(resolved)) out.set(line, resolved);
    }
    return out;
}

/** A crisp (nearest-neighbour) copy of `file` for the gutter, cached by content stamp. */
export function gutterIcon(cacheDir: string, file: string, size = 32): string | undefined {
    try {
        const st = fs.statSync(file);
        const hash = crypto.createHash("sha1").update(`${file}|${st.mtimeMs}|${st.size}|${size}`).digest("hex").slice(0, 16);
        const out = path.join(cacheDir, `${hash}.png`);
        if (fs.existsSync(out)) return out;
        const image = decodePng(fs.readFileSync(file));
        if (!image) return undefined;
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(out, encodePng(scaleNearest(image, thumbnailFactor(image.width, image.height, size))));
        return out;
    } catch {
        return undefined;
    }
}
