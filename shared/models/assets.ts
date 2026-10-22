// Which model assets the engine stores for a model file
// (src/assets/assetload_funcs.cpp load_vec3_model / load_obj_model /
// load_vcm_model, without the preload.json `squash` option):
// - .obj → one model `<name>`.
// - .vec3 → one model per sub-model: `<name>` when the sub-model is called
//   `<name>`, else `<name>.<sub>`. Not squashed, so the sub-model `origin`
//   is NOT applied.
// - .vcm with only the root part → `<name>` (squashed).
// - .vcm with bones → `<name>.<part>` per part (bone-local coordinates) and a
//   skeleton `<name>` whose bones use those models. No `<name>` model exists.

import type { ModelFormat } from "./index";
import type { ModelData, ModelMesh } from "./types";

/** A model file the host found for an asset name. */
export interface ModelFile {
    /** Asset name the file was loaded as (`models/<assetName>.<ext>`). */
    assetName: string;
    format: ModelFormat;
    data: ModelData;
    /** Absolute path (for live-update dependencies and errors). */
    file: string;
}

/** stored asset name → meshes, for one loaded model file. */
export function storedModels(model: ModelFile): Map<string, ModelMesh[]> {
    const name = model.assetName;
    const stored = new Map<string, ModelMesh[]>();
    const data = model.data;
    switch (model.format) {
        case "obj":
            stored.set(name, data.parts.flatMap((p) => p.meshes));
            break;
        case "vec3":
            for (const part of data.parts) {
                stored.set(part.name === name ? name : `${name}.${part.name}`, part.meshes);
            }
            break;
        case "vcm":
            if (data.parts.length === 1) {
                stored.set(name, data.parts[0].meshes);
            } else {
                for (const part of data.parts) stored.set(`${name}.${part.name}`, part.meshes);
            }
            break;
    }
    return stored;
}

/** True when the file also yields a skeleton named `assetName` (VCM with bones). */
export function hasVcmSkeleton(model: ModelFile): boolean {
    return model.format === "vcm" && model.data.parts.length > 1;
}

/** Engine-like squash: every part translated by its offset, merged. */
export function squashedMeshes(data: ModelData): ModelMesh[] {
    const out: ModelMesh[] = [];
    for (const part of data.parts) {
        const [ox, oy, oz] = part.offset;
        for (const mesh of part.meshes) {
            const positions = mesh.positions.slice();
            for (let i = 0; i < positions.length; i += 3) {
                positions[i] += ox;
                positions[i + 1] += oy;
                positions[i + 2] += oz;
            }
            out.push({ ...mesh, positions });
        }
    }
    return out;
}
