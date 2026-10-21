// Plain-data model produced by the preview mesh builders (vcm.ts, obj.ts,
// vec3.ts). Pure data: serialisable with postMessage / JSON.

import type { Span } from "../vcm/parser";

export type { Span };

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface ModelMesh {
    /** Texture name as written in the model (`$0`, `blocks:stone`, ...). */
    texture: string;
    /** `false` for `shading off` / vec3 shadeless materials. */
    shading: boolean;
    /** xyz per vertex; every 3 vertices form a triangle. */
    positions: number[];
    /** uv per vertex (engine convention: v = 0 is the image bottom). */
    uvs: number[];
    /** xyz per vertex (as the engine computes them, not renormalised). */
    normals: number[];
    /**
     * Per triangle: index into `ModelData.primitives`, or -1 when the
     * triangle has no source element (obj / vec3).
     */
    primitiveIds: number[];
}

export interface ModelPart {
    /** `root`, a named bone, or a vec3 model name; obj models use `""`. */
    name: string;
    /** Index into `ModelData.bones`, or -1. */
    bone: number;
    /**
     * Translation to apply when displaying the part (the bone's accumulated
     * offset as in `VcmModel::squash`, or the vec3 model origin).
     */
    offset: Vec3;
    meshes: ModelMesh[];
}

export interface ModelBone {
    name: string;
    /** Engine bone index (pre-order); 0 is the automatic `root` bone. */
    index: number;
    /** Parent bone index, -1 for root. */
    parent: number;
    /** Offset relative to the parent, as stored in the skeleton. */
    offset: Vec3;
    /** Accumulated offset from the root (what squash() translates by). */
    origin: Vec3;
    /** Source span of the `@bone` element. */
    span?: Span;
}

export interface ModelPrimitive {
    /** Element tag: `box`, `rect`, `tri`. */
    tag: string;
    /** Source span of the element. */
    span: Span;
    /** Box side index (0 west, 1 east, 2 bottom, 3 top, 4 north, 5 south). */
    side?: number;
    /** Spans of `@part` elements that affected this box side. */
    partSpans?: Span[];
}

export interface ModelError {
    message: string;
    span?: Span;
    severity: "error" | "warning";
}

export interface ModelData {
    kind: "vcm" | "obj" | "vec3";
    parts: ModelPart[];
    bones: ModelBone[];
    primitives: ModelPrimitive[];
    errors: ModelError[];
    /** Human-readable lines describing the file (shown in the header). */
    info: string[];
}

export function emptyMesh(texture: string, shading: boolean): ModelMesh {
    return { texture, shading, positions: [], uvs: [], normals: [], primitiveIds: [] };
}

/** Like `model::Model::addMesh`: reuse a mesh with the same texture+shading. */
export function addMesh(meshes: ModelMesh[], texture: string, shading = true): ModelMesh {
    for (const mesh of meshes) {
        if (mesh.texture === texture && mesh.shading === shading) {
            return mesh;
        }
    }
    const mesh = emptyMesh(texture, shading);
    meshes.push(mesh);
    return mesh;
}

/** Collects every texture name used by a model. */
export function modelTextures(model: ModelData): string[] {
    const names = new Set<string>();
    for (const part of model.parts) {
        for (const mesh of part.meshes) {
            names.add(mesh.texture);
        }
    }
    return [...names];
}

export function vertexCount(model: ModelData): number {
    let count = 0;
    for (const part of model.parts) {
        for (const mesh of part.meshes) {
            count += mesh.positions.length / 3;
        }
    }
    return count;
}
