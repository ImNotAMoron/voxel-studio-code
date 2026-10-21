// Unit tests for the preview mesh builders, selection mapping and texture
// resolver. Engine parity of the geometry itself is covered by golden.test.ts.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildModel, modelFormat, modelTextures } from "../../shared/models";
import { buildObjModel } from "../../shared/models/obj";
import { highlightSpans } from "../../shared/models/selection";
import { buildVcmModelFromText, parseDouble } from "../../shared/models/vcm";
import { buildVec3Model } from "../../shared/models/vec3";
import { parseVcm } from "../../shared/vcm/parser";
import { findPackRoot, resolveTexture, textureCandidates, textureSearchRoots } from "../../src/preview/textures";

const here = dirname(fileURLToPath(import.meta.url));
const resPath = join(here, "..", "..", "..", "res");

const meshesOf = (text: string) => buildVcmModelFromText(text).parts.flatMap((p) => p.meshes);

test("parseDouble follows util::parse_double (from_chars prefix)", () => {
    assert.equal(parseDouble(" +1.5"), 1.5);
    assert.equal(parseDouble("2, 3"), 2);
    assert.equal(parseDouble(".5"), 0.5);
    assert.equal(parseDouble("-1e2x"), -100);
    assert.throws(() => parseDouble(""));
    assert.throws(() => parseDouble("abc"));
});

test("vec3 values without commas are broadcast", () => {
    const a = meshesOf("@box from 0 to 1");
    const b = meshesOf("@box from (0,0,0) to (1,1,1)");
    assert.deepEqual(a, b);
});

test("shading is on unless literally off", () => {
    assert.equal(meshesOf("@rect from 0 right (1,0,0) up (0,1,0) shading no")[0].shading, true);
    assert.equal(meshesOf("@rect from 0 right (1,0,0) up (0,1,0) shading 'on'")[0].shading, true);
    assert.equal(meshesOf("@rect from 0 right (1,0,0) up (0,1,0) shading off")[0].shading, false);
});

test("box sides get default $N textures, delete removes sides", () => {
    const model = buildVcmModelFromText("@box from 0 to 1 delete (top, north)");
    assert.deepEqual(model.parts[0].meshes.map((m) => m.texture), ["$0", "$1", "$2", "$5"]);
    assert.equal(model.primitives.length, 4);
    assert.deepEqual(model.primitives.map((p) => p.side), [0, 1, 2, 5]);
});

test("part overrides texture and records its span", () => {
    const text = "@box from 0 to 1 texture 'a' {\n  @part tags (top, east) texture 'b'\n}";
    const model = buildVcmModelFromText(text);
    const textures = model.parts[0].meshes.map((m) => m.texture);
    assert.deepEqual(textures, ["a", "b"]);
    const top = model.primitives.find((p) => p.side === 3);
    assert.ok(top?.partSpans?.length === 1);
    assert.equal(text.slice(top.partSpans[0].start, top.partSpans[0].end).trim().startsWith("@part"), true);
});

test("triangles carry primitive ids pointing to their element span", () => {
    const text = "@rect from 0 right (1,0,0) up (0,1,0)\n@tri a (0,0,0) b (1,0,0) c (0,1,0) cull-face off";
    const model = buildVcmModelFromText(text);
    const mesh = model.parts[0].meshes[0];
    assert.equal(mesh.positions.length / 9, 4);
    assert.deepEqual(mesh.primitiveIds, [0, 0, 1, 1]);
    assert.equal(text.slice(model.primitives[1].span.start, model.primitives[1].span.end).startsWith("@tri"), true);
});

test("invalid elements are reported and skipped, the rest still builds", () => {
    const text = "@box from (0,0) to 1\n@rect from 0 up (0,1,0)\n@box from 0 to 1";
    const model = buildVcmModelFromText(text);
    const errors = model.errors.filter((e) => e.severity === "error");
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /invalid vec3/);
    assert.equal(text.slice(errors[0].span!.start, errors[0].span!.end), "(0,0)");
    assert.match(errors[1].message, /missing attribute right/);
    assert.equal(model.primitives.length, 6);
});

test("named bones become parts with accumulated offsets", () => {
    const model = buildVcmModelFromText(
        "@bone name a move (1,0,0) {\n @box from 0 to 1\n @bone name b move (0,2,0) { @box from 0 to 1 }\n}"
    );
    assert.deepEqual(model.bones.map((b) => [b.name, b.index, b.parent]), [["root", 0, -1], ["a", 1, 0], ["b", 2, 1]]);
    const b = model.parts.find((p) => p.name === "b");
    assert.deepEqual(b?.offset, [1, 2, 0]);
});

test("uv lists shorter than 6 numbers repeat (engine asNumbers wrap-around)", () => {
    const mesh = meshesOf("@tri a (0,0,0) b (1,0,0) c (0,1,0) uv (0.25,0.75)")[0];
    assert.deepEqual(mesh.uvs, [0.25, 0.75, 0.25, 0.75, 0.25, 0.75]);
});

test("highlightSpans picks the innermost element under each cursor", () => {
    const text = "@box from 0 to 1 {\n  @part tags top texture x\n}\n@rect from 0 right 1 up 1";
    const doc = parseVcm(text);
    const inPart = text.indexOf("tags");
    const inRect = text.indexOf("right");
    const spans = highlightSpans(doc.elements, [inPart, inRect, text.length + 5]);
    assert.equal(spans.length, 2);
    assert.ok(text.slice(spans[0].start, spans[0].end).startsWith("@part"));
    assert.ok(text.slice(spans[1].start, spans[1].end).startsWith("@rect"));
});

test("obj: faces before the first usemtl are skipped", () => {
    const model = buildObjModel("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
    assert.equal(model.parts[0].meshes.length, 0);
    assert.ok(model.errors.some((e) => e.severity === "warning"));
});

test("obj: fan triangulation, defaults for missing uv/normal", () => {
    const model = buildObjModel("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl stone\nf 1 2 3 4\n");
    const mesh = model.parts[0].meshes[0];
    assert.equal(mesh.texture, "stone");
    assert.equal(mesh.positions.length / 9, 2);
    assert.deepEqual(mesh.normals.slice(0, 3), [0, 1, 0]);
    assert.deepEqual(mesh.uvs.slice(0, 2), [0, 0]);
});

test("obj: negative indices are an error instead of the engine's endless loop", () => {
    const model = buildObjModel("v 0 0 0\nusemtl a\nf -1 -1 -1\n");
    assert.ok(model.errors.some((e) => e.severity === "error"));
});

test("vec3: invalid data is reported", () => {
    const model = buildVec3Model(new Uint8Array([1, 2, 3]));
    assert.equal(model.errors.length, 1);
    assert.match(model.errors[0].message, /magic/);
});

test("modelFormat / buildModel dispatch", () => {
    assert.equal(modelFormat("a/B.VCM"), "vcm");
    assert.equal(modelFormat("x.obj"), "obj");
    assert.equal(modelFormat("x.vec3"), "vec3");
    assert.equal(modelFormat("x.png"), undefined);
    assert.deepEqual(modelTextures(buildModel("vcm", "@box from 0 to 1 texture t")), ["t"]);
});

test("texture candidates follow the engine naming rules", () => {
    assert.deepEqual(textureCandidates("$0"), []);
    assert.deepEqual(textureCandidates("blocks:stone"), [join("textures", "blocks", "stone.png")]);
    assert.deepEqual(textureCandidates("entities/tireman:face_0"), [join("textures", "entities/tireman", "face_0.png")]);
    assert.deepEqual(textureCandidates("stone"), [join("textures", "stone.png"), join("textures", "blocks", "stone.png")]);
});

test("texture resolution against the engine res/", { skip: !existsSync(join(resPath, "content", "base", "package.json")) }, () => {
    const model = join(resPath, "content", "base", "models", "player-head.vec3");
    assert.equal(findPackRoot(model, resPath), join(resPath, "content", "base"));
    const roots = textureSearchRoots(model, resPath);
    assert.ok(resolveTexture("entities/player", roots)?.endsWith("player.png"));
    assert.ok(resolveTexture("blocks:stone", roots)?.endsWith("stone.png"));
    assert.ok(resolveTexture("stone", roots)?.endsWith("stone.png"));
    assert.equal(resolveTexture("blocks:no_such_texture", roots), undefined);
});
