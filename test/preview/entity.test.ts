// Entity / skeleton preview builder (shared/models/entity.ts) against the
// engine: EntityLoader.cpp, rigging.cpp (golden bone positions from
// test/preview/dumper/dump_blocks.cpp, see block.test.ts), Entities.cpp and
// the asset loader's model naming (shared/models/assets.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ContentIndex } from "../../shared/content";
import { buildModel } from "../../shared/models";
import { hasVcmSkeleton, storedModels } from "../../shared/models/assets";
import { boneMatrices, loadEntityDef, parseSkeleton } from "../../shared/models/entity";
import * as m from "../../shared/models/math";
import type { ModelData, Vec3 } from "../../shared/models/types";
import { DefResolver } from "../../src/preview/defs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const resPath = join(repoRoot, "res");
const fixturePack = join(here, "fixtures", "pvfix");
const golden = JSON.parse(readFileSync(join(here, "fixtures", "blocks-golden.json"), "utf8")) as {
    files: Record<string, { kind: string; bones?: { index: number; name: string; model: string; position: Vec3 }[] }>;
};

const index = new ContentIndex({ resPath, packDirs: [fixturePack] });
const resolver = new DefResolver(index);
const entity = (rel: string) => resolver.buildEntity(join(fixturePack, "entities", rel)).model;
const base = (name: string) => resolver.buildEntity(join(resPath, "content", "base", "entities", `${name}.json`)).model;
const part = (model: ModelData, name: string) => {
    const found = model.parts.find((p) => p.name === name);
    assert.ok(found, `part ${name} in ${model.parts.map((p) => p.name).join(", ")}`);
    return found;
};
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-5);

test("skeleton bone matrices match SkeletonConfig::update (engine golden)", () => {
    let checked = 0;
    for (const [file, entry] of Object.entries(golden.files)) {
        if (entry.kind !== "skeleton" || !entry.bones) continue;
        const skeleton = parseSkeleton("s", { text: readFileSync(join(repoRoot, file), "utf8") });
        const matrices = boneMatrices(skeleton, [0.5, 0.5, 0.5]);
        assert.equal(skeleton.bones.length, entry.bones.length, file);
        for (const bone of entry.bones) {
            const ours = skeleton.bones[bone.index];
            assert.equal(ours.name, bone.name, `${file} #${bone.index} name`);
            assert.equal(ours.model, bone.model, `${file} #${bone.index} model`);
            const pos = m.transform(matrices[bone.index], [0, 0, 0], 1);
            assert.ok(near(pos, bone.position), `${file} ${bone.name}: ${pos} != ${bone.position}`);
            checked++;
        }
    }
    assert.ok(checked >= 10, `${checked} bones`);
});

test("base:player: body + head at the skeleton offset, hitbox centered on the position", () => {
    const model = base("player");
    assert.equal(model.entity?.skeleton, "base:player");
    assert.equal(model.entity?.skeletonKind, "json");
    assert.deepEqual(model.entity?.origin, [0.5, 0.9, 0.5]);
    assert.deepEqual(part(model, "body").offset, [0.5, 0.9, 0.5]);
    assert.ok(near(part(model, "head").offset, [0.5, 1.3, 0.5]));
    const hitbox = model.overlays?.boxes.find((b) => b.kind === "entity-hitbox");
    assert.ok(hitbox && near(hitbox.min, [0.2, 0, 0.2]) && near(hitbox.max, [0.8, 1.8, 0.8]));
    // the bone without a model is still listed
    assert.ok(model.bones.some((b) => b.name === "item" && near(b.origin, [0.26, 0, -0.23])));
    assert.deepEqual(model.entity?.components.map((c) => [c.name, Boolean(c.file)]), [
        ["core:mob", true],
        ["core:player", true],
        ["base:player_animator", true],
    ]);
});

test("every base entity builds with its skeleton", () => {
    for (const name of ["player", "drop", "falling_block"]) {
        const model = base(name);
        assert.deepEqual(model.errors.filter((e) => e.severity !== "warning" || /not found/.test(e.message)), [], name);
        assert.ok(model.parts.length > 0, `${name} has geometry`);
    }
    // drop: two radius sensors around the hitbox center
    const drop = base("drop");
    assert.deepEqual(drop.overlays?.spheres.map((s) => [s.radius, s.center]), [
        [0.3, [0.5, 0.125, 0.5]],
        [1.6, [0.5, 0.125, 0.5]],
    ]);
    assert.equal(base("falling_block").entity?.skeleton, "base:block");
});

test("sensors: radius at the position, aabb boxes offset by the position", () => {
    const model = entity("robot.json");
    assert.equal(model.entity?.bodyType, "kinematic");
    assert.deepEqual(model.overlays?.spheres.map((s) => [s.radius, s.center]), [[0.75, [0.5, 0.5, 0.5]]]);
    const box = model.overlays?.boxes.find((b) => b.kind === "sensor");
    assert.deepEqual([box?.min, box?.max], [[-0.5, 0.5, -0.5], [1.5, 2.5, 1.5]]);
});

test("parent: components and sensors appended, skeleton-name inherited (EntityDef::cloneTo)", () => {
    const model = entity("robot_child.json");
    assert.deepEqual(model.entity?.components.map((c) => c.name), ["pvfix:brain", "pvfix:missing", "base:drop"]);
    assert.equal(model.entity?.skeleton, "pvfix:robot", "the parent's skeleton, not pvfix:robot_child");
    // child sensor indices restart at 0 (EntityLoader uses the local index)
    assert.deepEqual(model.overlays?.spheres.map((s) => s.label), ["sensor 0", "sensor 0"]);
    const def = loadEntityDef("t:e", [{ text: '{"parent": "t:none"}' }], () => undefined);
    assert.ok(def.errors.some((e) => /Failed to find parent/.test(e.message)));
});

test("components resolve to scripts/components/<name>.lua", () => {
    const model = entity("robot.json");
    assert.deepEqual(model.entity?.components.map((c) => [c.name, Boolean(c.file)]), [
        ["pvfix:brain", true],
        ["pvfix:missing", false],
    ]);
    const warning = model.errors.find((e) => /pvfix:missing/.test(e.message));
    assert.ok(warning?.span, "span on the component");
});

test("JSON skeleton: nested offsets accumulate, `a.b` bone models load asset `a`", () => {
    const model = entity("robot.json");
    assert.deepEqual(part(model, "base").offset, [0.5, 0.5, 0.5]);
    assert.deepEqual(part(model, "torso").offset, [0.5, 1, 0.5]);
    assert.ok(near(part(model, "head").offset, [0.6, 1.25, 0.3]));
    // torso uses "human.head": the VCM human (bones) stores human.<bone>
    assert.ok(part(model, "torso").meshes.length > 0);
    assert.ok(model.errors.some((e) => /bone "broken": model "nope" not found/.test(e.message)));
    assert.ok(!model.parts.some((p) => p.name === "empty"));
    // the skeleton file alone
    const skel = resolver.buildSkeleton(join(fixturePack, "skeletons", "robot.json")).model;
    assert.deepEqual(skel.parts.map((p) => p.name), ["base", "torso", "head"]);
    assert.ok(skel.bones[0].span, "bone spans for selection");
});

test("VCM skeleton: skeleton-name without ':' uses models/<name>.vcm bones (load_vcm_model)", () => {
    const model = entity("humanoid.json");
    assert.equal(model.entity?.skeletonKind, "model");
    const body = part(model, "body");
    const head = part(model, "head");
    assert.ok(near(head.offset, [body.offset[0], body.offset[1] + 0.5, body.offset[2]]), `${head.offset}`);
    assert.ok(near(part(model, "leg_left_btm").offset, [0.5 - 0.125, 0.9 - 0.45, 0.5]));
});

test("missing skeletons: warning for the default name, error otherwise (Entities.cpp)", () => {
    const ghost = entity("ghost.json");
    assert.ok(ghost.errors.some((e) => e.severity === "error" && /pvfix:nothing not found/.test(e.message)));
    const def = loadEntityDef("t:nobody", [{ text: "{}" }], () => undefined);
    assert.equal(def.skeletonName, "t:nobody");
    assert.deepEqual(def.hitbox, [0.25, 0.25, 0.25]);
});

test("stored model names follow the asset loader", () => {
    const vec3 = new Uint8Array(readFileSync(join(resPath, "content", "base", "models", "player-body.vec3")));
    const data = buildModel("vec3", vec3);
    assert.deepEqual([...storedModels({ assetName: "player-body", format: "vec3", data, file: "" }).keys()], ["player-body"]);
    assert.deepEqual([...storedModels({ assetName: "other", format: "vec3", data, file: "" }).keys()], ["other.player-body"]);
    const human = buildModel("vcm", readFileSync(join(resPath, "models", "human.vcm"), "utf8"));
    const humanFile = { assetName: "human", format: "vcm" as const, data: human, file: "" };
    assert.ok(hasVcmSkeleton(humanFile));
    assert.ok(storedModels(humanFile).has("human.head"));
    assert.ok(!storedModels(humanFile).has("human"));
    const stairs = buildModel("vcm", readFileSync(join(resPath, "models", "stairs.vcm"), "utf8"));
    assert.deepEqual([...storedModels({ assetName: "stairs", format: "vcm", data: stairs, file: "" }).keys()], ["stairs"]);
});
