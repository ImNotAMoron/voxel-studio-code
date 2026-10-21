// Golden test: the preview mesh builders must produce exactly what the
// engine's loaders produce (within float32 tolerance).
//
// fixtures/golden.json is the output of the engine's own vcm::parse,
// obj::parse and vec3::load, dumped by test/preview/dumper (a tiny C++ tool
// linked against the built VoxelCoreSrc library; the Lua API cannot do this:
// assets.parse_model needs Assets, which do not exist headless, and nothing
// reads mesh vertices back into Lua).
//
// Regenerate (from the repo root, after building the engine):
//   cmake -S vscode-extension/test/preview/dumper -B <tmp>/dumper \
//     -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake \
//     -DVCPKG_INSTALLED_DIR=$PWD/build/vcpkg_installed -DVCPKG_MANIFEST_MODE=OFF \
//     -DVCPKG_TARGET_TRIPLET=x64-windows
//   cmake --build <tmp>/dumper --config Debug
//   <tmp>/dumper/Debug/dump_models vscode-extension/test/preview/fixtures/golden.json \
//     res/models/*.vcm res/models/*.vec3 res/content/base/models/*.vec3 \
//     vscode-extension/test/preview/fixtures/models/*
// Keys of golden.json are those paths (relative to the repo root).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildObjModel } from "../../shared/models/obj";
import type { ModelMesh } from "../../shared/models/types";
import { buildVcmModelFromText } from "../../shared/models/vcm";
import { loadVec3 } from "../../shared/models/vec3";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixturesDir = join(here, "fixtures");

interface GoldenMesh {
    texture: string;
    shading: boolean;
    vertices: (number | null)[];
}
type GoldenEntry =
    | { kind: "vcm"; parts: Record<string, GoldenMesh[]>; bones: { name: string; index: number; parent: number; offset: number[] }[] }
    | { kind: "obj"; meshes: GoldenMesh[] }
    | { kind: "vec3"; materials: { flags: number; name: string }[]; models: Record<string, { origin: number[]; meshes: GoldenMesh[] }> }
    | { error: string };

const golden = JSON.parse(readFileSync(join(fixturesDir, "golden.json"), "utf8")) as Record<string, GoldenEntry>;

const EPS = 1e-4;

function close(a: number, b: number | null): boolean {
    if (b === null) return !Number.isFinite(a);
    return Math.abs(a - b) <= EPS * Math.max(1, Math.abs(b));
}

function compareMeshes(actual: ModelMesh[], expected: GoldenMesh[], where: string) {
    assert.deepEqual(
        actual.map((m) => `${m.texture}/${m.shading}`),
        expected.map((m) => `${m.texture}/${m.shading}`),
        `${where}: mesh list`
    );
    actual.forEach((mesh, i) => {
        const exp = expected[i].vertices;
        const count = mesh.positions.length / 3;
        assert.equal(count, exp.length / 8, `${where} mesh ${i} (${mesh.texture}): vertex count`);
        assert.equal(mesh.primitiveIds.length, count / 3, `${where} mesh ${i}: one primitive id per triangle`);
        for (let v = 0; v < count; v++) {
            const got = [
                mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2],
                mesh.uvs[v * 2], mesh.uvs[v * 2 + 1],
                mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2],
            ];
            const want = exp.slice(v * 8, v * 8 + 8);
            if (!got.every((g, k) => close(g, want[k]))) {
                assert.fail(
                    `${where} mesh ${i} (${mesh.texture}) vertex ${v}:\n` +
                    `  got  ${got.map((n) => n.toFixed(5)).join(", ")}\n` +
                    `  want ${want.map((n) => (n === null ? "nan" : n.toFixed(5))).join(", ")}`
                );
            }
        }
    });
}

const entries = Object.entries(golden);

test("golden fixture covers every engine model", () => {
    const keys = new Set(Object.keys(golden));
    for (const key of [
        "res/models/human.vcm",
        "res/models/stairs.vcm",
        "res/models/block.vec3",
        "res/models/drop-item.vec3",
        "res/content/base/models/drop-block.vec3",
        "res/content/base/models/player-body.vec3",
        "res/content/base/models/player-hand.vec3",
        "res/content/base/models/player-head.vec3",
    ]) {
        assert.ok(keys.has(key), `missing ${key}`);
    }
    assert.ok(entries.length >= 10);
});

for (const [path, entry] of entries) {
    test(`golden: ${path}`, () => {
        const prefix = "vscode-extension/";
        const file = path.startsWith(prefix)
            ? join(here, "..", "..", path.slice(prefix.length))
            : join(repoRoot, path);
        if (!existsSync(file)) {
            // engine checkout not available: fixture-only models still run
            return;
        }
        assert.ok(!("error" in entry), `engine failed on ${path}: ${"error" in entry ? entry.error : ""}`);
        if ("error" in entry) return;
        if (entry.kind === "vcm") {
            const model = buildVcmModelFromText(readFileSync(file, "utf8"));
            assert.deepEqual(model.errors.filter((e) => e.severity === "error"), []);
            assert.deepEqual(
                model.parts.map((p) => p.name).sort(),
                Object.keys(entry.parts).sort(),
                "part names"
            );
            for (const part of model.parts) {
                compareMeshes(part.meshes, entry.parts[part.name], `part ${part.name}`);
            }
            assert.equal(model.bones.length, entry.bones.length, "bone count");
            for (const bone of entry.bones) {
                const mine = model.bones.find((b) => b.index === bone.index);
                assert.ok(mine, `bone ${bone.index}`);
                assert.equal(mine.name, bone.name);
                assert.equal(mine.parent, bone.parent, `parent of ${bone.name}`);
                assert.ok(mine.offset.every((v, k) => close(v, bone.offset[k])), `offset of ${bone.name}: ${mine.offset} vs ${bone.offset}`);
            }
        } else if (entry.kind === "obj") {
            const model = buildObjModel(readFileSync(file, "utf8"));
            assert.deepEqual(model.errors.filter((e) => e.severity === "error"), []);
            compareMeshes(model.parts[0].meshes, entry.meshes, "obj");
        } else {
            const vec3 = loadVec3(new Uint8Array(readFileSync(file)));
            assert.deepEqual(vec3.materials, entry.materials);
            assert.deepEqual(vec3.models.map((m) => m.name).sort(), Object.keys(entry.models).sort());
            for (const model of vec3.models) {
                const exp = entry.models[model.name];
                assert.ok(model.origin.every((v, k) => close(v, exp.origin[k])), "origin");
                compareMeshes(model.meshes.map((m) => m.mesh), exp.meshes, `model ${model.name}`);
            }
        }
    });
}
