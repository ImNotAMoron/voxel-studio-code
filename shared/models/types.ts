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
    /**
     * Constant brightness multiplier baked by the engine (X sprites use 0.8,
     * BlocksRenderer::blockXSprite). Absent = 1.
     */
    tint?: number;
    /** Alpha-blended (block `translucent`); otherwise alpha-tested. */
    translucent?: boolean;
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
    /** Source span of the `@bone` element (or skeleton JSON node). */
    span?: Span;
    /** File of `span` when it is not the previewed document. */
    file?: string;
    /** Asset name of the bone's model (entity skeletons). */
    model?: string;
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
    /**
     * Source file of `span` (absolute path) when it is not the previewed
     * document, e.g. a value inherited from a `parent` definition.
     */
    file?: string;
}

export interface ModelError {
    message: string;
    span?: Span;
    severity: "error" | "warning";
}

/** Where a value came from: a span in the previewed document or in `file`. */
export interface SourceRef {
    span: Span;
    /** Absolute path; absent = the previewed document. */
    file?: string;
}

export type OverlayKind = "hitbox" | "size" | "cell" | "sensor" | "entity-hitbox";

/** Axis-aligned wireframe box in model space. */
export interface OverlayBox {
    kind: OverlayKind;
    min: Vec3;
    max: Vec3;
    label?: string;
    source?: SourceRef;
}

export interface OverlaySphere {
    kind: OverlayKind;
    center: Vec3;
    radius: number;
    label?: string;
    source?: SourceRef;
}

/** Text label with an arrow along `normal` (block face labels). */
export interface OverlayLabel {
    position: Vec3;
    normal: Vec3;
    text: string;
    /** texture-faces index the label belongs to. */
    face?: number;
}

export interface ModelOverlays {
    boxes: OverlayBox[];
    spheres: OverlaySphere[];
    labels: OverlayLabel[];
}

export interface BlockFlag {
    name: string;
    value: boolean | number | string;
}

/** Block preview metadata (shared/models/block.ts). */
export interface BlockInfo {
    id: string;
    /** Model type of the shown variant: block, X, aabb, custom, none. */
    model: string;
    modelName?: string;
    variant: number;
    /** Number of selectable variants (1 = no state-based variants). */
    variantCount: number;
    rotation: number;
    rotationCount: number;
    profile: string;
    /** Texture names of the shown variant, texture-faces order. */
    textureFaces: string[];
    /** Light emission r, g, b in 0..15. */
    emission: [number, number, number];
    flags: BlockFlag[];
    /** `parent` chain, nearest first. */
    parents: string[];
}

export interface EntityComponentInfo {
    name: string;
    /** scripts/components/<name>.lua when found. */
    file?: string;
    source?: SourceRef;
}

/** Entity / skeleton preview metadata (shared/models/entity.ts). */
export interface EntityInfo {
    id: string;
    skeleton: string;
    /** "json" skeleton file, "model" (VCM with bones), or "missing". */
    skeletonKind: "json" | "model" | "missing";
    skeletonFile?: string;
    bodyType?: string;
    hitbox?: Vec3;
    components: EntityComponentInfo[];
    /** Entity position (hitbox center) in preview space. */
    origin: Vec3;
}

export interface ModelData {
    kind: "vcm" | "obj" | "vec3" | "block" | "entity";
    parts: ModelPart[];
    bones: ModelBone[];
    primitives: ModelPrimitive[];
    errors: ModelError[];
    /** Human-readable lines describing the file (shown in the header). */
    info: string[];
    /** Wireframe boxes, spheres and labels drawn over the model. */
    overlays?: ModelOverlays;
    /**
     * Directional shading formula: "model" (ModelBatch, default) or
     * "block" (BlocksRenderer::SUN_VECTOR with factor 0.3).
     */
    shadingModel?: "model" | "block";
    block?: BlockInfo;
    entity?: EntityInfo;
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
