import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ContentIndex } from "../../shared/content/index";
import { formatDuration, oggDuration } from "../../shared/assets/audio";
import { alphaKind, decodePng, pngHeader, scaleNearest, thumbnail, thumbnailFactor } from "../../shared/assets/png";
import { hover } from "../../server/src/features/language";
import { createEnv } from "../../server/src/linter";
import { gutterIcon, textureLines } from "../../src/thumbnails/lines";
import { BASE, GOODPACK, RES } from "./helpers";

const index = new ContentIndex({ resPath: RES, packDirs: [GOODPACK] });
const env = createEnv(index, {}, true);

function hoverAt(file: string, text: string, marker: string, delta = 1): string {
    const doc = TextDocument.create("file:///x", "json", 1, text);
    const h = hover(env, doc, file, text.indexOf(marker) + delta);
    return h ? (h.contents as { value: string }).value : "";
}

test("thumbnails: nearest-neighbour upscale, facts from the header", () => {
    const file = path.join(BASE, "textures", "blocks", "grass_top.png");
    const buf = fs.readFileSync(file);
    const image = decodePng(buf)!;
    assert.deepEqual([image.width, image.height], [16, 16]);
    assert.equal(thumbnailFactor(16, 16), 8);
    assert.equal(thumbnailFactor(1024, 1024), 0.25);
    const scaled = scaleNearest(image, 8);
    // every 8×8 block repeats one source pixel
    assert.deepEqual([...scaled.rgba.subarray(0, 4)], [...scaled.rgba.subarray(7 * 4, 7 * 4 + 4)]);
    assert.deepEqual([...scaled.rgba.subarray(0, 4)], [...image.rgba.subarray(0, 4)]);
    const t = thumbnail(buf)!;
    assert.match(t.dataUri, /^data:image\/png;base64,/);
    assert.equal(decodePng(Buffer.from(t.dataUri.split(",")[1], "base64"))!.width, 128);
    assert.equal(pngHeader(buf)!.colorType, t.header.colorType);
    const kind = (name: string) => alphaKind(decodePng(fs.readFileSync(path.join(BASE, "textures", "blocks", name)))!);
    assert.equal(kind("glass.png"), "translucent");
    assert.equal(kind("grass_top.png"), "opaque");
});

test("sound durations", () => {
    const dir = path.join(BASE, "sounds", "steps");
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".ogg"))!);
    const seconds = oggDuration(fs.readFileSync(file))!;
    assert.ok(seconds > 0.05 && seconds < 10, String(seconds));
    assert.match(formatDuration(seconds), /^\d+\.\d+ s$/);
});

test("texture hover: thumbnail, size, alpha and an open link", () => {
    const file = path.join(GOODPACK, "blocks", "x.json");
    const md = hoverAt(file, '{"texture": "crate"}', '"crate"', 2);
    assert.match(md, /block texture `crate` → `goodpack:textures\/blocks\/crate\.png`/);
    assert.match(md, /!\[crate\.png\]\(data:image\/png;base64,/);
    assert.match(md, /\d+×\d+ · (RGBA|RGB|indexed)/);
    assert.match(md, /\[Open\]\(command:voxelcore\.openFile\?/);
    // the item icon form
    const icon = hoverAt(path.join(GOODPACK, "items", "x.json"), '{"icon": "items:wand"}', "items:", 2);
    assert.match(icon, /data:image\/png/);
});

test("texture-faces hover: the six faces in engine order", () => {
    const file = path.join(GOODPACK, "blocks", "crate_open.json");
    const text = fs.readFileSync(file, "utf8");
    const onKey = hoverAt(file, text, '"texture-faces"', 3);
    assert.match(onKey, /\| 0: -X \| 1: \+X \| 2: -Y \| 3: \+Y \| 4: -Z \| 5: \+Z \|/);
    assert.equal((onKey.match(/data:image\/png/g) ?? []).length, 6);
    // on an element: that texture, then all six
    const onFace = hoverAt(file, text, '"crate_open"', 2);
    assert.match(onFace, /block texture `crate_open`/);
    assert.match(onFace, /3: \+Y/);
});

test("sound, model and caption hovers", () => {
    const material = path.join(GOODPACK, "block_materials", "wood.json");
    const sound = hoverAt(material, fs.readFileSync(material, "utf8"), '"crate/open"', 2);
    assert.match(sound, /2 variants/);
    assert.match(sound, /▶ open_0\.ogg\]\(command:voxelcore\.openFile.*· (\d+\.\d+ s|\?)/);
    const model = hoverAt(path.join(GOODPACK, "blocks", "x.json"), '{"model": "custom", "model-name": "statue"}', '"statue"', 2);
    assert.match(model, /VCM · \d+ triangles · size [\d.]+ × [\d.]+ × [\d.]+/);
    assert.match(model, /\[Open preview\]\(command:voxelcore\.previewFile/);
    const caption = hoverAt(path.join(GOODPACK, "blocks", "x.json"), '{"caption": "grass block"}', '"grass', 2);
    assert.match(caption, /translations of `grass block`/);
    assert.match(caption, /\| ru_RU \| дёрн \| base \|/);
    const lua = hoverAt(path.join(GOODPACK, "scripts", "world.lua"), 'local s = gui.str("Cancel")', '"Cancel', 2);
    assert.match(lua, /\| ru_RU \| Отмена \| core \|/);
    const none = hoverAt(path.join(GOODPACK, "blocks", "x.json"), '{"caption": "no such text"}', '"no', 2);
    assert.match(none, /the engine shows the key itself/);
});

test("gutter: one texture per line, crisp cached icons", () => {
    const file = path.join(GOODPACK, "blocks", "crate_open.json");
    const lines = textureLines(index, file, fs.readFileSync(file, "utf8"));
    assert.equal(lines.size, 6);
    assert.ok([...lines.values()].every((f) => /crate(_open)?\.png$/.test(f)));
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), "vc-thumbs-"));
    try {
        const icon = gutterIcon(cache, [...lines.values()][0])!;
        assert.equal(decodePng(fs.readFileSync(icon))!.width, 32);
        assert.equal(gutterIcon(cache, [...lines.values()][0]), icon, "cached");
    } finally {
        fs.rmSync(cache, { recursive: true, force: true });
    }
});
