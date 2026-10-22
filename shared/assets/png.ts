// PNG helpers for hover thumbnails and gutter icons (FEATURES.md §3.9):
// nearest-neighbour scaling keeps 16×16 pixel art readable.
import { PNG } from "pngjs";

export interface RgbaImage {
    width: number;
    height: number;
    /** RGBA8, rows top to bottom. */
    rgba: Uint8Array;
}

export interface PngHeader {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlaced: boolean;
}

export const COLOR_TYPE_NAMES: Record<number, string> = { 0: "grayscale", 2: "RGB", 3: "indexed", 4: "grayscale + alpha", 6: "RGBA" };

/** The IHDR chunk. */
export function pngHeader(buf: Uint8Array): PngHeader | undefined {
    const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (b.length < 29 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("ascii", 12, 16) !== "IHDR") return undefined;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25], interlaced: b[28] === 1 };
}

export function decodePng(buf: Uint8Array): RgbaImage | undefined {
    try {
        const png = PNG.sync.read(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
        return { width: png.width, height: png.height, rgba: png.data };
    } catch {
        return undefined;
    }
}

export function encodePng(image: RgbaImage): Buffer {
    const png = new PNG({ width: image.width, height: image.height });
    png.data = Buffer.from(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength);
    return PNG.sync.write(png);
}

/** "opaque", "cutout" (only fully transparent or opaque pixels) or "translucent". */
export function alphaKind(image: RgbaImage): "opaque" | "cutout" | "translucent" {
    let transparent = false;
    for (let i = 3; i < image.rgba.length; i += 4) {
        const a = image.rgba[i];
        if (a !== 0 && a !== 255) return "translucent";
        if (a === 0) transparent = true;
    }
    return transparent ? "cutout" : "opaque";
}

export function scaleNearest(image: RgbaImage, factor: number): RgbaImage {
    if (factor === 1) return image;
    const width = Math.max(1, Math.round(image.width * factor));
    const height = Math.max(1, Math.round(image.height * factor));
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const sy = Math.min(image.height - 1, Math.floor(y / factor));
        for (let x = 0; x < width; x++) {
            const sx = Math.min(image.width - 1, Math.floor(x / factor));
            const s = (sy * image.width + sx) * 4;
            rgba.set(image.rgba.subarray(s, s + 4), (y * width + x) * 4);
        }
    }
    return { width, height, rgba };
}

/** Integer upscale for small images, downscale for big ones, to about `target` px. */
export function thumbnailFactor(width: number, height: number, target = 128): number {
    const size = Math.max(width, height);
    if (size <= 0) return 1;
    if (size < target) return Math.max(1, Math.floor(target / size));
    return Math.min(1, (target * 2) / size);
}

/** A scaled PNG of `file`'s image as a data URI, plus facts for the hover. */
export function thumbnail(buf: Uint8Array, target = 128): { dataUri: string; header: PngHeader; alpha: ReturnType<typeof alphaKind>; scale: number } | undefined {
    const header = pngHeader(buf);
    const image = decodePng(buf);
    if (!header || !image) return undefined;
    const scale = thumbnailFactor(image.width, image.height, target);
    const scaled = scaleNearest(image, scale);
    return { dataUri: `data:image/png;base64,${encodePng(scaled).toString("base64")}`, header, alpha: alphaKind(image), scale };
}
