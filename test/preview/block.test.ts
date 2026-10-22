// Block preview builder (shared/models/block.ts) against the engine.
//
// Expected values are derived by hand from the C++ (cited per test) or come
// from fixtures/blocks-golden.json, dumped by the engine's own code
// (test/preview/dumper/dump_blocks.cpp: BlockRotProfile constants,
// CoordSystem::transform + AABB::fix, ModelsGenerator::loadCustomBlockModel,
// SkeletonConfig::update). Regenerate it like golden.json (see the header of
// golden.test.ts), building the `dump_blocks` target, then from the repo root:
//   <tmp>/dumper/Debug/dump_blocks vscode-extension/test/preview/fixtures/blocks-golden.json \
//     res/content/base/blocks/*.json packs/backrooms/blocks/*.json \
//     vscode-extension/test/preview/fixtures/pvfix/blocks/*.json \
//     res/content/base/skeletons/*.json vscode-extension/test/preview/fixtures/pvfix/skeletons/*.json

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ContentIndex } from "../../shared/content";
import {
    aabbFaces,
    buildBlockModel,
    cubeFaces,
    FACE_NORMALS,
    finalizeBlock,
    legacyCustomModel,
    loadBlockDef,
    ROTATION_PROFILES,
    rotatedHitboxes,
    type BlockDef,
} from "../../shared/models/block";
import type { ModelData, ModelMesh, Vec3 } from "../../shared/models/types";
import { DefResolver, previewKind } from "../../src/preview/defs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const resPath = join(repoRoot, "res");
const fixturePack = join(here, "fixtures", "pvfix");
const backrooms = join(repoRoot, "packs", "backrooms");
const golden = JSON.parse(readFileSync(join(here, "fixtures", "blocks-golden.json"), "utf8")) as {
    profiles: Record<string, { axes: Vec3[]; fix: Vec3 }[]>;
    files: Record<string, { kind: string; hitboxes?: [Vec3, Vec3][]; rotation?: string; rotated?: [Vec3, Vec3][][]; primitives?: { texture: string; vertices: number[] }[]; error?: string }>;
};

const index = new ContentIndex({ resPath, packDirs: [fixturePack, ...(existsSync(backrooms) ? [backrooms] : [])] });
const resolver = new DefResolver(index);

const def = (json: unknown, id = "t:x"): BlockDef => loadBlockDef(id, [{ text: JSON.stringify(json, null, 4) }], () => undefined);
const build = (json: unknown, options = {}) => buildBlockModel(finalizeBlock(def(json)), options);
const meshes = (model: ModelData) => model.parts.flatMap((p) => p.meshes);
const mesh = (model: ModelData, texture: string): ModelMesh => {
    const found = meshes(model).find((m) => m.texture === texture);
    assert.ok(found, `mesh ${texture} in ${meshes(model).map((m) => m.texture).join(", ")}`);
    return found;
};
const vertex = (m: ModelMesh, i: number) => ({
    pos: m.positions.slice(i * 3, i * 3 + 3),
    uv: m.uvs.slice(i * 2, i * 2 + 2),
    normal: m.normals.slice(i * 3, i * 3 + 3),
});
const near = (a: number[], b: number[], eps = 1e-5) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);
const assertNear = (a: number[], b: number[], what: string, eps = 1e-5) => assert.ok(near(a, b, eps), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const fixtureFile = (rel: string) => join(fixturePack, rel);
const FACES = ["mx", "px", "my", "py", "mz", "pz"];

test("texture-faces order -x, +x, -y, +y, -z, +z (BlocksRenderer::blockCube)", () => {
    const model = build({ "texture-faces": FACES });
    for (let i = 0; i < 6; i++) {
        const m = mesh(model, `blocks:${FACES[i]}`);
        assert.equal(m.positions.length / 3, 6);
        for (let v = 0; v < 6; v++) assertNear(vertex(m, v).normal, FACE_NORMALS[i], `face ${i} normal`);
    }
    // labels name the direction and the index
    assert.deepEqual(
        model.overlays?.labels.map((l) => l.text).sort(),
        ["+X [1] px", "+Y [3] py", "+Z [5] pz", "-X [0] mx", "-Y [2] my", "-Z [4] mz"]
    );
});

test("cube face UV orientation (BlocksRenderer::face corners (u1,v1) at -X-Y)", () => {
    const model = build({ "texture-faces": FACES });
    // faceAO(coord, X, Y, Z): +Z face, u along +x, v along +y
    assert.deepEqual(vertex(mesh(model, "blocks:pz"), 0), { pos: [0, 0, 1], uv: [0, 0], normal: [0, 0, 1] });
    assert.deepEqual(vertex(mesh(model, "blocks:pz"), 1).pos, [1, 0, 1]);
    // faceAO(coord, Z, Y, -X): -X face, u along +z
    assert.deepEqual(vertex(mesh(model, "blocks:mx"), 0).pos, [0, 0, 0]);
    assert.deepEqual(vertex(mesh(model, "blocks:mx"), 1), { pos: [0, 0, 1], uv: [1, 0], normal: [-1, 0, 0] });
    // faceAO(coord, -Z, Y, X): +X face, u along -z
    assert.deepEqual(vertex(mesh(model, "blocks:px"), 0).pos, [1, 0, 1]);
    // faceAO(coord, X, -Z, Y): top, image bottom row at +z
    assert.deepEqual(vertex(mesh(model, "blocks:py"), 0), { pos: [0, 1, 1], uv: [0, 0], normal: [0, 1, 0] });
    // faceAO(coord, X, Z, -Y): bottom, image bottom row at -z
    assert.deepEqual(vertex(mesh(model, "blocks:my"), 0), { pos: [0, 0, 0], uv: [0, 0], normal: [0, -1, 0] });
    // index(0, 1, 2, 0, 2, 3)
    assert.deepEqual(vertex(mesh(model, "blocks:pz"), 3).pos, [0, 0, 1]);
    assert.deepEqual(vertex(mesh(model, "blocks:pz"), 5).pos, [0, 1, 1]);
});

test("aabb: union of hitboxes, full UVs (not cut), own bottom-face basis (BlocksRenderer::blockAABB)", () => {
    const model = build({ model: "aabb", "texture-faces": FACES, hitboxes: [[0.25, 0, 0.25, 0.5, 0.5, 0.5], [0.25, 0.5, 0.25, 0.5, 0.5, 0.5]] });
    const px = mesh(model, "blocks:px");
    for (let v = 0; v < 6; v++) assert.equal(vertex(px, v).pos[0], 0.75);
    assert.deepEqual([...new Set(px.uvs)].sort(), [0, 1]);
    // faceAO(coord, -X*sx, -Z*sz, -Y*sy) for the bottom: (u1,v1) at +x,+z
    assert.deepEqual(vertex(mesh(model, "blocks:my"), 0), { pos: [0.75, 0, 0.75], uv: [0, 0], normal: [0, -1, 0] });
    // the cube's bottom has (u1,v1) at -x,-z: the AABB bottom texture is turned 180°
    const cube = cubeFaces(ROTATION_PROFILES.none.variants[0].axes).find((f) => f.face === 2);
    const box = aabbFaces([{ a: [0, 0, 0], b: [1, 1, 1] }], undefined).find((f) => f.face === 2);
    assert.deepEqual(cube?.quad.corners[0], [0, 0, 0]);
    assert.deepEqual(box?.quad.corners[0], [1, 0, 1]);
});

test("X sprite geometry (BlocksRenderer::blockXSprite)", () => {
    const model = build({ model: "X", "texture-faces": ["front", "b", "c", "d", "back", "f"] });
    const front = mesh(model, "blocks:front");
    const back = mesh(model, "blocks:back");
    assert.equal(front.positions.length / 9, 4);
    assert.equal(back.positions.length / 9, 4);
    for (const m of [front, back]) {
        assert.equal(m.tint, 0.8);
        assert.equal(m.shading, false, "constant tint, no directional shading");
        for (let v = 0; v < m.positions.length / 3; v++) assert.deepEqual(vertex(m, v).normal, [0, 1, 0]);
    }
    const h = 0.5 / 1.41;
    // face(coord, w, 1, 0, {-1,0,1}, ...), index(0, 1, 3, 1, 2, 3)
    assertNear(vertex(front, 0).pos, [0.5 + h, 0, 0.5 - h], "v0");
    assertNear(vertex(front, 1).pos, [0.5 - h, 0, 0.5 + h], "v1");
    assertNear(vertex(front, 2).pos, [0.5 + h, 1, 0.5 - h], "v3");
    assertNear(vertex(front, 3).pos, [0.5 - h, 0, 0.5 + h], "v1'");
    assert.deepEqual(vertex(front, 2).uv, [0, 1]);
    // rotation is ignored, shadeless too
    assert.deepEqual(build({ model: "X", rotation: "pipe", shadeless: true }, { rotation: 0 }).parts[0].meshes[0].positions, meshes(build({ model: "X" }))[0].positions);
});

test("rotation profiles match Block.cpp (engine golden) and are proper rotations", () => {
    for (const [name, variants] of Object.entries(golden.profiles)) {
        const ours = ROTATION_PROFILES[name];
        assert.ok(ours, name);
        assert.equal(ours.variants.length, variants.length, `${name} count`);
        variants.forEach((cs, i) => {
            assert.deepEqual(ours.variants[i].axes, cs.axes, `${name}[${i}] axes`);
            assert.deepEqual(ours.variants[i].fix, cs.fix, `${name}[${i}] fix`);
            const [x, y, z] = cs.axes;
            const det = x[0] * (y[1] * z[2] - y[2] * z[1]) - x[1] * (y[0] * z[2] - y[2] * z[0]) + x[2] * (y[0] * z[1] - y[1] * z[0]);
            assert.equal(det, 1, `${name}[${i}] is a rotation`);
        });
    }
    assert.equal(ROTATION_PROFILES.none.variants.length, 1);
});

test("hitboxes and rotated hitboxes match ContentBuilder (engine golden)", () => {
    let checked = 0;
    for (const [file, entry] of Object.entries(golden.files)) {
        if (entry.kind !== "block" || !entry.hitboxes) continue;
        const abs = join(repoRoot, file);
        if (!existsSync(abs)) continue;
        const json = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
        if ("size" in json || "parent" in json) continue; // size replaces hitboxes; parents aren't dumped
        const d = finalizeBlock(def(json, file));
        entry.hitboxes.forEach((box, i) => assertNear([...d.hitboxes[i].a, ...d.hitboxes[i].b], [...box[0], ...box[1]], `${file} hitbox ${i}`));
        assert.equal(d.hitboxes.length, entry.hitboxes.length);
        entry.rotated?.forEach((boxes, r) => {
            const ours = rotatedHitboxes(d, r).map((h) => [...h.a, ...h.b]);
            boxes.forEach((box, i) => assertNear(ours[i], [...box[0], ...box[1]], `${file} rotation ${r} box ${i}`));
            checked++;
        });
    }
    assert.ok(checked >= 20, `checked ${checked} rotations`);
});

test("pipe east lays a vertical pipe along X (CoordSystem::transform + fix, derived)", () => {
    const d = finalizeBlock(def({ model: "aabb", rotation: "pipe", hitbox: [0.25, 0, 0.25, 0.5, 1, 0.5] }));
    assert.deepEqual(rotatedHitboxes(d, 1), [{ a: [0, 0.25, 0.25], b: [1, 0.75, 0.75] }]);
    // the drawn box follows the hitbox
    const model = buildBlockModel(d, { rotation: 1 });
    const xs = meshes(model).flatMap((m) => m.positions.filter((_, i) => i % 3 === 0));
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 1]);
});

test("rotation applies the orientation axes to cube faces", () => {
    // pipe north: Y = (0,0,1), so texture-faces[3] (top) faces +Z
    const model = build({ "texture-faces": FACES, rotation: "pipe" }, { rotation: 0 });
    assertNear(vertex(mesh(model, "blocks:py"), 0).normal, [0, 0, 1], "top → +Z");
    assertNear(vertex(mesh(model, "blocks:pz"), 0).normal, [0, -1, 0], "+Z → -Y");
    assert.equal(model.block?.rotationCount, 6);
    assert.ok(model.overlays?.labels.some((l) => l.text === "+Z [3] py"));
    // stairs: 8 orientations, upside-down ones flip Y
    const stairs = build({ "texture-faces": FACES, rotation: "stairs" }, { rotation: 4 });
    assertNear(vertex(mesh(stairs, "blocks:py"), 0).normal, [0, -1, 0], "stairs #4 top → -Y");
    // non-rotatable blocks ignore the option
    assert.equal(build({ texture: "a" }, { rotation: 3 }).block?.rotation, 0);
});

test("model-primitives match ModelsGenerator::loadCustomBlockModel (engine golden)", () => {
    const file = "vscode-extension/test/preview/fixtures/pvfix/blocks/legacy.json";
    const expected = golden.files[file]?.primitives;
    assert.ok(expected, "golden entry");
    const json = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as { "model-primitives": unknown };
    const ours = legacyCustomModel(json["model-primitives"], true, []);
    const key = (v: number[]) => v.map((x) => x.toFixed(4)).join(",");
    const flatten = (pos: number[], uv: number[], n: number[]) => {
        const out: string[] = [];
        for (let i = 0; i < pos.length / 3; i++) out.push(key([...pos.slice(i * 3, i * 3 + 3), ...uv.slice(i * 2, i * 2 + 2), ...n.slice(i * 3, i * 3 + 3)]));
        return out;
    };
    const actual = ours.flatMap((m) => flatten(m.positions, m.uvs, m.normals)).sort();
    const engine: string[] = [];
    for (const m of expected) for (let i = 0; i < m.vertices.length / 8; i++) engine.push(key(m.vertices.slice(i * 8, i * 8 + 8)));
    assert.deepEqual(actual, engine.sort());
    // textures: boxes use blocks:<name>, one mesh per texture in the preview
    assert.deepEqual(ours.map((m) => m.texture), ["blocks:one", "blocks:a", "blocks:b", "blocks:c", "blocks:d", "blocks:e", "blocks:f", "blocks:quad"]);
});

test("custom model-name: $N → texture-faces[N], rotated about the cell center (prepareModel, blockCustomModel)", () => {
    const north = resolver.buildBlock(fixtureFile("blocks/slab.json"), { rotation: 0 }).model;
    assert.deepEqual(meshes(north).map((m) => m.texture).sort(), ["blocks:side", "blocks:top"]);
    // the top rect (y = 0.5, normal +Y) under pipe north (Y → +Z, Z → -Y)
    const top = mesh(north, "blocks:top");
    for (let v = 0; v < top.positions.length / 3; v++) {
        assertNear(vertex(top, v).normal, [0, 0, 1], "normal");
        assert.ok(Math.abs(vertex(top, v).pos[2] - 0.5) < 1e-6);
    }
    // up (#4) is the identity
    const up = resolver.buildBlock(fixtureFile("blocks/slab.json"), { rotation: 4 }).model;
    assertNear(vertex(mesh(up, "blocks:top"), 0).normal, [0, 1, 0], "up");
    // triangles of the $3 mesh point at texture-faces[3]
    const prim = north.primitives[top.primitiveIds[0]];
    const text = readFileSync(fixtureFile("blocks/slab.json"), "utf8");
    assert.equal(text.slice(prim.span.start, prim.span.end), '"top"');
    assert.equal(prim.side, 3);
    assert.equal(north.errors.length, 0, north.errors.map((e) => e.message).join("; "));
});

test("custom model with bones is rejected like the engine (no squashed model stored)", () => {
    const d = finalizeBlock(def({ model: "custom", "model-name": "human" }));
    const model = buildBlockModel(d, { loadModel: (name) => resolver.loadModel(name) });
    assert.ok(model.errors.some((e) => e.severity === "error" && /has bones/.test(e.message)));
    assert.ok(meshes(model).length > 0, "still shown squashed");
    const missing = buildBlockModel(finalizeBlock(def({ model: "custom", "model-name": "nope" })), { loadModel: () => undefined });
    assert.ok(missing.errors.some((e) => /could not find model "nope"/.test(e.message)));
});

test("state-based variants: 0 = root, variants[i] = i + 1, copied from the root (BlockLoader)", () => {
    const file = fixtureFile("blocks/variants.json");
    const at = (variant: number) => resolver.buildBlock(file, { variant }).model;
    assert.equal(at(0).block?.variantCount, 4);
    assert.deepEqual(at(0).block?.textureFaces, Array(6).fill("root_tex"));
    assert.equal(at(0).block?.model, "block");
    assert.deepEqual(at(1).block?.textureFaces, Array(6).fill("v1"));
    assert.equal(at(2).block?.model, "X");
    assert.deepEqual(at(2).block?.textureFaces, Array(6).fill("root_tex"));
    assert.equal(at(3).block?.model, "aabb");
    assert.deepEqual(at(3).block?.textureFaces, ["a", "b", "c", "d", "e", "f"]);
    // aabb variants use the block's (shared) hitbox
    const ys = meshes(at(3)).flatMap((m) => m.positions.filter((_, i) => i % 3 === 1));
    assert.equal(Math.max(...ys), 0.5);
    assert.equal(at(99).block?.variant, 3, "clamped");
    // face primitives point into the variant's JSON
    const text = readFileSync(file, "utf8");
    const prim = at(1).primitives.find((p) => p.side === 0);
    assert.ok(prim && text.slice(prim.span.start, prim.span.end) === '"v1"');
});

test("variants above the bit mask are unreachable", () => {
    const model = build({ texture: "r", "state-based": { bits: 1, variants: [{ texture: "a" }, { texture: "b" }] } });
    assert.equal(model.block?.variantCount, 2);
    assert.ok(model.errors.some((e) => /unreachable/.test(e.message)));
    assert.ok(build({ "state-based": { bits: 9, variants: [] } }).errors.some((e) => /Invalid state-based/.test(e.message)));
});

test("parent: Block::cloneTo then the child's keys (ContentIndex finds the parent file)", () => {
    const model = resolver.buildBlock(fixtureFile("blocks/child.json")).model;
    assert.deepEqual(model.block?.parents, ["pvfix:cube"]);
    assert.deepEqual(model.block?.textureFaces, Array(6).fill("child_tex"));
    assert.deepEqual(model.block?.emission, [15, 7, 0]);
    assert.ok(meshes(model).every((m) => m.translucent === true));
    // a parent in another pack, live text wins
    const live = new DefResolver(index, (f) => (f.endsWith("cube.json") ? JSON.stringify({ texture: "live" }) : undefined));
    const fromLive = live.buildBlock(fixtureFile("blocks/child.json")).model;
    assert.deepEqual(fromLive.block?.textureFaces, Array(6).fill("child_tex"), "child overrides");
    const childOfBase = loadBlockDef("t:c", [{ text: '{"parent": "base:pane"}' }], (id) =>
        id === "base:pane" ? loadBlockDef(id, [{ text: readFileSync(join(resPath, "content/base/blocks/pane.json"), "utf8") }], () => undefined) : undefined
    );
    assert.equal(childOfBase.defaults.model, "aabb");
    assert.equal(childOfBase.profile, "pane");
    assert.equal(childOfBase.hitboxes[0].b[2], 0.2);
    const orphan = def({ parent: "t:missing" });
    assert.ok(orphan.errors.some((e) => /Failed to find parent\(t:missing\)/.test(e.message) && e.span));
    // live text of the previewed document
    assert.deepEqual(live.buildBlock(fixtureFile("blocks/cube.json")).model.block?.textureFaces, Array(6).fill("live"));
});

test("inherited state-based variants replace the child's root model/texture (ContentBuilder)", () => {
    const model = resolver.buildBlock(fixtureFile("blocks/vchild.json")).model;
    assert.deepEqual(model.block?.textureFaces, Array(6).fill("root_tex"));
    assert.ok(model.errors.some((e) => e.severity === "warning" && /variant 0/.test(e.message)));
});

test("size: block → aabb with a size hitbox, rotated cells (BlockLoader, ContentBuilder)", () => {
    const north = resolver.buildBlock(fixtureFile("blocks/big.json"), { rotation: 0 }).model;
    assert.equal(north.block?.model, "aabb");
    const boxes = north.overlays?.boxes ?? [];
    assert.deepEqual(boxes.find((b) => b.kind === "hitbox")?.max, [2, 1, 1]);
    assert.deepEqual(boxes.find((b) => b.kind === "size")?.max, [2, 1, 1]);
    assert.equal(boxes.filter((b) => b.kind === "cell").length, 2);
    // pane east: X → -Z, fix (0, 0, 1): cells at z = -1 and 0
    const east = resolver.buildBlock(fixtureFile("blocks/big.json"), { rotation: 1 }).model;
    const size = east.overlays?.boxes.find((b) => b.kind === "size");
    assert.deepEqual([size?.min, size?.max], [[0, 0, -1], [1, 1, 1]]);
    assert.deepEqual(east.overlays?.boxes.filter((b) => b.kind === "cell").map((c) => c.min[2]), [-1, 0]);
    // with state-based variants, defaults = variants[0] (a BLOCK copy) wins
    const withVariants = finalizeBlock(def({ texture: "s", size: [2, 1, 1], "state-based": { variants: [{}] } }));
    assert.equal(withVariants.defaults.model, "block");
    assert.equal(withVariants.hitboxes[0].b[0], 2);
});

test("loader errors and warnings carry spans", () => {
    const text = '{\n    "texture-faces": ["a", "b"],\n    "model": "sphere",\n    "rotation": "spin"\n}';
    const d = loadBlockDef("t:e", [{ text }], () => undefined);
    const find = (re: RegExp) => d.errors.find((e) => re.test(e.message));
    assert.equal(find(/requires 6 elements/)?.severity, "error");
    assert.equal(text.slice(find(/requires 6/)!.span!.start, find(/requires 6/)!.span!.end), '["a", "b"]');
    assert.equal(find(/unknown model: sphere/)?.severity, "warning");
    assert.equal(d.defaults.model, "none");
    assert.equal(find(/unknown rotation profile spin/)?.severity, "warning");
    assert.equal(d.rotatable, false);
    assert.ok(def({ shadeless: 1 }).errors.some((e) => /boolean expected/.test(e.message)));
    // `texture` wins over `texture-faces`
    assert.deepEqual(def({ texture: "t", "texture-faces": FACES }).defaults.textureFaces, Array(6).fill("t"));
    // engine JSON: comments and trailing commas
    assert.equal(loadBlockDef("t:c", [{ text: '{ # comment\n "texture": "x", }' }], () => undefined).defaults.textureFaces[0], "x");
});

test("rt.solid like ContentBuilder: block model, obstacle and a full first hitbox", () => {
    const solid = (json: unknown) => finalizeBlock(def(json)).rt?.solid;
    assert.equal(solid({}), true);
    assert.equal(solid({ model: "aabb" }), false);
    assert.equal(solid({ model: "custom", "model-name": "m", solid: true }), true);
    assert.equal(solid({ obstacle: false }), false);
    assert.equal(solid({ hitbox: [0, 0, 0, 1, 0.5, 1] }), false);
    assert.equal(solid({ model: "aabb", culling: "optional" }), true);
});

test("every block in base, backrooms and the fixtures builds without errors", { skip: !existsSync(backrooms) && "no ../packs/backrooms" }, () => {
    let count = 0;
    for (const unit of index.blocks.values()) {
        if (!unit.file || ["pvfix:vchild"].includes(unit.id)) continue;
        for (const variant of [0, 1, 2, 3]) {
            const { model } = resolver.buildBlock(unit.file, { variant, rotation: 0 });
            const errors = model.errors.filter((e) => e.severity === "error");
            assert.deepEqual(errors, [], `${unit.id}#${variant}`);
            if (model.block?.model !== "none") assert.ok(meshes(model).length > 0, `${unit.id} has geometry`);
            if ((model.block?.variantCount ?? 1) <= variant + 1) break;
        }
        count++;
    }
    assert.ok(count >= 26 + 23 + 8, `${count} blocks`);
});

test("previewKind detects definitions by their place in a pack", () => {
    assert.equal(previewKind(fixtureFile("blocks/cube.json")), "block");
    assert.equal(previewKind(fixtureFile("entities/robot.json")), "entity");
    assert.equal(previewKind(fixtureFile("skeletons/robot.json")), "skeleton");
    assert.equal(previewKind(fixtureFile("models/pvslab.vcm")), "vcm");
    assert.equal(previewKind(fixtureFile("package.json")), undefined);
    assert.equal(previewKind(join(resPath, "content", "base", "blocks", "stone.json"), resPath), "block");
    assert.equal(previewKind(join(here, "fixtures", "_x", "blocks", "a.json")), undefined);
});
