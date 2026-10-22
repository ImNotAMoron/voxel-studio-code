// Block preview (FEATURES.md §5.4): block definition JSON → ModelData.
//
// Ports, in engine order:
// 1. src/content/loading/BlockLoader.cpp  loadUnit / load_variant
//    (`parent` → Block::cloneTo, every definition file of the unit is applied
//    on top of the same Block, see ContentLoader.cpp loadDefs).
// 2. src/content/ContentBuilder.cpp build(): `defaults = variants[0]`,
//    rt.solid, rotated hitboxes (CoordSystem::transform + AABB::fix).
// 3. src/graphics/render/BlocksRenderer.cpp blockCube / blockXSprite /
//    blockAABB / blockCustomModel geometry, and
//    src/graphics/render/ModelsGenerator.cpp prepareModel /
//    loadCustomBlockModel (custom models, `$N` textures, model-primitives).
//
// Coordinates: the engine meshes a block around its integer coordinate and
// the chunk mesh is drawn at +0.5 (ChunksRenderer.cpp), so a block occupies
// [x, x+1]. The preview uses the origin cell [0, 1]^3, center (0.5, 0.5, 0.5).
// UVs are per texture (0..1) instead of atlas regions; v = 0 is the bottom
// row like the engine's bottom-up PNGs.

import type { JSONPath } from "jsonc-parser";

import { squashedMeshes, storedModels, type ModelFile } from "./assets";
import { asBoolean, asInteger, asNumber, asString, DefTypeError, isObject, JsonDef, type DefText } from "./jsondef";
import {
    addMesh,
    type BlockFlag,
    type ModelData,
    type ModelError,
    type ModelMesh,
    type ModelOverlays,
    type ModelPrimitive,
    type SourceRef,
    type Vec3,
} from "./types";

export type { DefText };

/** core_defs.hpp TEXTURE_NOTFOUND */
export const TEXTURE_NOTFOUND = "notfound";
/** Block.hpp BLOCK_MAX_VARIANTS */
export const BLOCK_MAX_VARIANTS = 16;
/** constants.hpp EXTENDED_BLOCK_LIMIT (= CHUNK_W) */
export const EXTENDED_BLOCK_LIMIT = 16;

/**
 * texture-faces order: Block.hpp FACE_MX..FACE_PZ, `-x, x, -y, y, -z, z`.
 * BlocksRenderer::blockCube draws texfaces[1] on the face whose normal is +X,
 * texfaces[0] on -X, [2] -Y, [3] +Y, [4] -Z, [5] +Z.
 */
export const FACE_NAMES = ["-X", "+X", "-Y", "+Y", "-Z", "+Z"];
export const FACE_NORMALS: Vec3[] = [
    [-1, 0, 0],
    [1, 0, 0],
    [0, -1, 0],
    [0, 1, 0],
    [0, 0, -1],
    [0, 0, 1],
];

// ---- rotation profiles (src/voxels/Block.cpp) ----

export type Axes = [Vec3, Vec3, Vec3];

export interface CoordSystem {
    axes: Axes;
    /** Grid fix offset for negative axes (CoordSystem::CoordSystem). */
    fix: Vec3;
}

function coordSystem(x: Vec3, y: Vec3, z: Vec3): CoordSystem {
    const fix: Vec3 = [0, 0, 0];
    for (const axis of [x, y, z]) {
        if (axis[0] < 0 || axis[1] < 0 || axis[2] < 0) {
            fix[0] -= axis[0];
            fix[1] -= axis[1];
            fix[2] -= axis[2];
        }
    }
    return { axes: [x, y, z], fix };
}

export interface RotationProfile {
    name: string;
    /** Orientation names as commented in Block.cpp. */
    labels: string[];
    variants: CoordSystem[];
}

const IDENTITY = coordSystem([1, 0, 0], [0, 1, 0], [0, 0, 1]);

export const ROTATION_PROFILES: Record<string, RotationProfile> = {
    none: { name: "none", labels: ["default"], variants: [IDENTITY] },
    pipe: {
        name: "pipe",
        labels: ["north", "east", "south", "west", "up", "down"],
        variants: [
            coordSystem([1, 0, 0], [0, 0, 1], [0, -1, 0]),
            coordSystem([0, 0, 1], [-1, 0, 0], [0, -1, 0]),
            coordSystem([-1, 0, 0], [0, 0, -1], [0, -1, 0]),
            coordSystem([0, 0, -1], [1, 0, 0], [0, -1, 0]),
            coordSystem([1, 0, 0], [0, 1, 0], [0, 0, 1]),
            coordSystem([1, 0, 0], [0, -1, 0], [0, 0, -1]),
        ],
    },
    pane: {
        name: "pane",
        labels: ["north", "east", "south", "west"],
        variants: [
            coordSystem([1, 0, 0], [0, 1, 0], [0, 0, 1]),
            coordSystem([0, 0, -1], [0, 1, 0], [1, 0, 0]),
            coordSystem([-1, 0, 0], [0, 1, 0], [0, 0, -1]),
            coordSystem([0, 0, 1], [0, 1, 0], [-1, 0, 0]),
        ],
    },
    stairs: {
        name: "stairs",
        labels: ["north", "east", "south", "west", "north (flipped)", "east (flipped)", "south (flipped)", "west (flipped)"],
        variants: [
            coordSystem([1, 0, 0], [0, 1, 0], [0, 0, 1]),
            coordSystem([0, 0, -1], [0, 1, 0], [1, 0, 0]),
            coordSystem([-1, 0, 0], [0, 1, 0], [0, 0, -1]),
            coordSystem([0, 0, 1], [0, 1, 0], [-1, 0, 0]),
            coordSystem([-1, 0, 0], [0, -1, 0], [0, 0, 1]),
            coordSystem([0, 0, 1], [0, -1, 0], [1, 0, 0]),
            coordSystem([1, 0, 0], [0, -1, 0], [0, 0, -1]),
            coordSystem([0, 0, -1], [0, -1, 0], [-1, 0, 0]),
        ],
    },
    // identical to pane in Block.cpp (the docs describe it differently)
    ladder: {
        name: "ladder",
        labels: ["north", "east", "south", "west"],
        variants: [
            coordSystem([1, 0, 0], [0, 1, 0], [0, 0, 1]),
            coordSystem([0, 0, -1], [0, 1, 0], [1, 0, 0]),
            coordSystem([-1, 0, 0], [0, 1, 0], [0, 0, -1]),
            coordSystem([0, 0, 1], [0, 1, 0], [-1, 0, 0]),
        ],
    },
};

export interface AABB {
    a: Vec3;
    b: Vec3;
}

const axisMul = (axes: Axes, v: Vec3): Vec3 => [
    axes[0][0] * v[0] + axes[1][0] * v[1] + axes[2][0] * v[2],
    axes[0][1] * v[0] + axes[1][1] * v[1] + axes[2][1] * v[2],
    axes[0][2] * v[0] + axes[1][2] * v[1] + axes[2][2] * v[2],
];

/** CoordSystem::transform (no AABB::fix: a/b may end up swapped). */
export function transformAABB(cs: CoordSystem, box: AABB): AABB {
    const a = axisMul(cs.axes, box.a);
    const b = axisMul(cs.axes, box.b);
    return {
        a: [a[0] + cs.fix[0], a[1] + cs.fix[1], a[2] + cs.fix[2]],
        b: [b[0] + cs.fix[0], b[1] + cs.fix[1], b[2] + cs.fix[2]],
    };
}

/** AABB::fix: a = min, b = max. */
export function fixAABB(box: AABB): AABB {
    return {
        a: [Math.min(box.a[0], box.b[0]), Math.min(box.a[1], box.b[1]), Math.min(box.a[2], box.b[2])],
        b: [Math.max(box.a[0], box.b[0]), Math.max(box.a[1], box.b[1]), Math.max(box.a[2], box.b[2])],
    };
}

const aabbSize = (box: AABB): Vec3 => [Math.abs(box.b[0] - box.a[0]), Math.abs(box.b[1] - box.a[1]), Math.abs(box.b[2] - box.a[2])];
const aabbCenter = (box: AABB): Vec3 => [(box.a[0] + box.b[0]) / 2, (box.a[1] + box.b[1]) / 2, (box.a[2] + box.b[2]) / 2];

// ---- definition (Block / Variant) ----

export type BlockModelType = "none" | "block" | "X" | "aabb" | "custom";
const MODEL_TYPES: BlockModelType[] = ["none", "block", "X", "aabb", "custom"];
const CULLING_MODES = ["default", "optional", "disabled"];

export interface VariantDef {
    model: BlockModelType;
    modelName: string;
    /** model-primitives (legacy inline custom model) */
    customRaw: unknown;
    textureFaces: string[];
    /** Source of each texture-faces entry (`texture` or `texture-faces[i]`). */
    faceRefs: (SourceRef | undefined)[];
    modelRef?: SourceRef;
    modelNameRef?: SourceRef;
    customRef?: SourceRef;
    culling: string;
    drawGroup: number;
    /** Variant::rt.solid (ContentBuilder) */
    solid: boolean;
}

export interface BlockDef {
    id: string;
    defaults: VariantDef;
    variants?: { offset: number; mask: number; list: VariantDef[]; configured: number; inherited: boolean };
    material: string;
    emission: [number, number, number];
    size: Vec3;
    sizeRef?: SourceRef;
    lightPassing: boolean;
    skyLightPassing: boolean;
    shadeless: boolean;
    ambientOcclusion: boolean;
    obstacle: boolean;
    selectable: boolean;
    replaceable: boolean;
    breakable: boolean;
    rotatable: boolean;
    grounded: boolean;
    hidden: boolean;
    translucent: boolean;
    explicitlySolid: boolean;
    profile: string;
    hitboxes: AABB[];
    hitboxRefs: (SourceRef | undefined)[];
    /** `parent` chain, nearest first. */
    parents: string[];
    errors: ModelError[];
    /** Set by finalizeBlock (ContentBuilder::build). */
    rt?: { solid: boolean; extended: boolean };
}

function newVariant(): VariantDef {
    return {
        model: "block",
        modelName: "",
        customRaw: null,
        textureFaces: Array<string>(6).fill(TEXTURE_NOTFOUND),
        faceRefs: Array<SourceRef | undefined>(6).fill(undefined),
        culling: "default",
        drawGroup: 0,
        solid: true,
    };
}

function cloneVariant(v: VariantDef): VariantDef {
    return { ...v, textureFaces: [...v.textureFaces], faceRefs: [...v.faceRefs] };
}

export function newBlockDef(id: string): BlockDef {
    return {
        id,
        defaults: newVariant(),
        material: "",
        emission: [0, 0, 0],
        size: [1, 1, 1],
        lightPassing: false,
        skyLightPassing: false,
        shadeless: false,
        ambientOcclusion: true,
        obstacle: true,
        selectable: true,
        replaceable: false,
        breakable: true,
        rotatable: false,
        grounded: false,
        hidden: false,
        translucent: false,
        explicitlySolid: false,
        profile: "none",
        hitboxes: [{ a: [0, 0, 0], b: [1, 1, 1] }],
        hitboxRefs: [undefined],
        parents: [],
        errors: [],
    };
}

/** Block::cloneTo (fields relevant to the preview). */
function cloneInto(src: BlockDef, dst: BlockDef) {
    dst.defaults = cloneVariant(src.defaults);
    if (src.variants) {
        dst.variants = { ...src.variants, list: src.variants.list.map(cloneVariant), inherited: true };
    }
    dst.material = src.material;
    dst.emission = [...src.emission];
    dst.size = [...src.size];
    dst.sizeRef = src.sizeRef;
    for (const key of [
        "lightPassing", "skyLightPassing", "shadeless", "ambientOcclusion", "obstacle", "selectable", "replaceable",
        "breakable", "rotatable", "grounded", "hidden", "translucent", "explicitlySolid",
    ] as const) {
        dst[key] = src[key];
    }
    dst.hitboxes = src.hitboxes.map((h) => ({ a: [...h.a], b: [...h.b] }));
    dst.hitboxRefs = [...src.hitboxRefs];
    dst.profile = src.profile;
}

/** Per-file loading context: reports errors with spans (main document only). */
class Loader {
    constructor(readonly json: JsonDef, readonly def: BlockDef) {}

    error(message: string, path: JSONPath, severity: "error" | "warning" = "error") {
        const ref = this.json.ref(path);
        const where = this.json.file ? ` (in ${this.json.file})` : "";
        const error: ModelError = { message: message + where, severity };
        if (ref && !ref.file) error.span = ref.span;
        this.def.errors.push(error);
    }

    /** Runs `fn`; a dv type error / engine exception becomes an error at `path`. */
    guard(path: JSONPath, fn: () => void) {
        try {
            fn();
        } catch (err) {
            if (err instanceof DefTypeError || err instanceof LoadError) this.error(err.message, path);
            else throw err;
        }
    }
}

class LoadError extends Error {}

/** BlockLoader.cpp load_variant */
function loadVariant(ctx: Loader, variant: VariantDef, root: Record<string, unknown>, path: JSONPath) {
    const json = ctx.json;
    if ("texture" in root) {
        ctx.guard([...path, "texture"], () => {
            const texture = asString(root.texture, "texture");
            const ref = json.ref([...path, "texture"]);
            for (let i = 0; i < 6; i++) {
                variant.textureFaces[i] = texture;
                variant.faceRefs[i] = ref;
            }
        });
    } else if ("texture-faces" in root) {
        ctx.guard([...path, "texture-faces"], () => {
            const arr = root["texture-faces"];
            if (!Array.isArray(arr) || arr.length < 6) {
                throw new LoadError("texture-faces requires 6 elements");
            }
            for (let i = 0; i < 6; i++) {
                variant.textureFaces[i] = asString(arr[i], `texture-faces[${i}]`);
                variant.faceRefs[i] = json.ref([...path, "texture-faces", i]);
            }
        });
    }

    let modelTypeName: string = variant.model;
    ctx.guard([...path, "model"], () => {
        if ("model" in root) {
            modelTypeName = asString(root.model, "model");
            variant.modelRef = json.ref([...path, "model"]);
        }
    });
    ctx.guard([...path, "model-name"], () => {
        if ("model-name" in root) {
            variant.modelName = asString(root["model-name"], "model-name");
            variant.modelNameRef = json.ref([...path, "model-name"]);
        }
    });
    if ((MODEL_TYPES as string[]).includes(modelTypeName)) {
        variant.model = modelTypeName as BlockModelType;
        if (variant.model === "custom" && variant.customRaw === null) {
            if ("model-primitives" in root) {
                variant.customRaw = root["model-primitives"];
                variant.customRef = json.ref([...path, "model-primitives"]);
            } else if (variant.modelName === "") {
                ctx.error(`${ctx.def.id}: no 'model-primitives' or 'model-name' found`, [...path, "model"]);
            }
        }
    } else if (modelTypeName !== "") {
        // logger.error() only: the block loads as invisible
        ctx.error(`unknown model: ${modelTypeName} (the engine uses "none")`, [...path, "model"], "warning");
        variant.model = "none";
    }

    ctx.guard([...path, "culling"], () => {
        if ("culling" in root) {
            const culling = asString(root.culling, "culling");
            if (CULLING_MODES.includes(culling)) variant.culling = culling;
            else ctx.error(`unknown culling mode: ${culling}`, [...path, "culling"], "warning");
        }
    });
    ctx.guard([...path, "draw-group"], () => {
        if ("draw-group" in root) variant.drawGroup = asInteger(root["draw-group"], "draw-group") & 0xff;
    });
}

function readBox(arr: unknown, what: string): AABB {
    if (!Array.isArray(arr)) throw new DefTypeError(`${what}: list expected`);
    const n = (i: number) => {
        if (i >= arr.length) throw new LoadError(`${what}: index ${i} out of range`);
        return asNumber(arr[i], what);
    };
    const a: Vec3 = [n(0), n(1), n(2)];
    const b: Vec3 = [a[0] + n(3), a[1] + n(4), a[2] + n(5)];
    return { a, b };
}

/**
 * Applies one definition file onto `def` (ContentUnitLoader<Block>::loadUnit).
 * `getParent` returns the already loaded parent block (not finalized).
 */
export function applyBlockFile(def: BlockDef, source: DefText, getParent: (id: string) => BlockDef | undefined) {
    const json = new JsonDef(source);
    const ctx = new Loader(json, def);
    if (!source.file) def.errors.push(...json.errors);
    const root = json.root;
    if (!root) {
        ctx.error("block definition must be a JSON object", []);
        return;
    }
    const bool = (key: string, set: (v: boolean) => void) =>
        ctx.guard([key], () => {
            if (key in root) set(asBoolean(root[key], key));
        });

    if ("parent" in root) {
        ctx.guard(["parent"], () => {
            const parentName = asString(root.parent, "parent");
            const parent = getParent(parentName);
            if (!parent) throw new LoadError(`Failed to find parent(${parentName}) for ${def.id}`);
            cloneInto(parent, def);
            def.parents = [parentName, ...parent.parents];
        });
    }

    loadVariant(ctx, def.defaults, root, []);

    const stateBased = root["state-based"];
    if (isObject(stateBased) && "variants" in stateBased) {
        ctx.guard(["state-based"], () => {
            const variants = stateBased.variants;
            let offset = 0;
            let bits = 4;
            if ("offset" in stateBased) offset = asInteger(stateBased.offset, "offset");
            if ("bits" in stateBased) bits = asInteger(stateBased.bits, "bits");
            if (offset < 0 || bits <= 0 || offset + bits > 8) {
                throw new LoadError("Invalid state-based bits configuration");
            }
            const list = [cloneVariant(def.defaults)];
            const count = Array.isArray(variants) ? variants.length : 0;
            for (let i = 0; i < count; i++) {
                const variant = cloneVariant(def.defaults);
                const value = (variants as unknown[])[i];
                if (isObject(value)) loadVariant(ctx, variant, value, ["state-based", "variants", i]);
                list.push(variant);
            }
            if (list.length > BLOCK_MAX_VARIANTS) {
                ctx.error(`${list.length - 1} variants: at most ${BLOCK_MAX_VARIANTS - 1} fit (BLOCK_MAX_VARIANTS)`, ["state-based", "variants"]);
                list.length = BLOCK_MAX_VARIANTS;
            }
            const configured = list.length;
            while (list.length < BLOCK_MAX_VARIANTS) list.push(cloneVariant(def.defaults));
            const mask = (1 << bits) - 1;
            if (configured - 1 > mask) {
                ctx.error(`variants above index ${mask} are unreachable with ${bits} bits`, ["state-based", "bits"], "warning");
            }
            def.variants = { offset, mask, list, configured, inherited: false };
        });
    } else if (def.variants?.inherited && ["texture", "texture-faces", "model", "model-name", "model-primitives"].some((k) => k in root)) {
        // ContentBuilder::build sets defaults = variants[0], and the inherited
        // variants[0] is the parent's root variant.
        ctx.error(
            "the parent's state-based variants are inherited: the engine replaces this root model/texture with the parent's variant 0",
            ["parent"],
            "warning"
        );
    }

    ctx.guard(["material"], () => {
        if ("material" in root) def.material = asString(root.material, "material");
    });

    ctx.guard(["rotation"], () => {
        let profile = def.profile;
        if ("rotation" in root) profile = asString(root.rotation, "rotation");
        def.rotatable = profile !== "none";
        if (ROTATION_PROFILES[profile] && profile !== "none") {
            def.profile = profile;
        } else if (profile !== "none") {
            ctx.error(`unknown rotation profile ${profile}`, ["rotation"], "warning");
            def.rotatable = false;
        }
    });

    if ("hitboxes" in root) {
        ctx.guard(["hitboxes"], () => {
            const arr = root.hitboxes;
            if (!Array.isArray(arr)) throw new DefTypeError("hitboxes: list expected");
            def.hitboxes = arr.map((box, i) => readBox(box, `hitboxes[${i}]`));
            def.hitboxRefs = arr.map((_, i) => json.ref(["hitboxes", i]));
        });
    } else if ("hitbox" in root) {
        ctx.guard(["hitbox"], () => {
            def.hitboxes = [readBox(root.hitbox, "hitbox")];
            def.hitboxRefs = [json.ref(["hitbox"])];
        });
    }

    if ("emission" in root) {
        ctx.guard(["emission"], () => {
            const arr = root.emission;
            if (!Array.isArray(arr)) throw new DefTypeError("emission: list expected");
            for (let i = 0; i < 3; i++) {
                if (i >= arr.length) throw new LoadError("emission: 3 values expected");
                def.emission[i] = Math.min(15, Math.max(0, asInteger(arr[i], "emission")));
            }
        });
    }

    if ("size" in root) {
        ctx.guard(["size"], () => {
            const arr = root.size;
            if (!Array.isArray(arr) || arr.length < 3) throw new LoadError("size: 3 values expected");
            // stored in glm::i8vec3
            const size: Vec3 = [0, 1, 2].map((i) => ((asInteger(arr[i], "size") << 24) >> 24)) as Vec3;
            def.size = size;
            def.sizeRef = json.ref(["size"]);
            if (size.some((v) => v < 1)) throw new LoadError(`block "${def.id}": invalid block size`);
            if (size.some((v) => v > EXTENDED_BLOCK_LIMIT)) {
                throw new LoadError(`extended block "${def.id}" size limit ${EXTENDED_BLOCK_LIMIT} exceeded`);
            }
            if (def.defaults.model === "block" && (size[0] !== 1 || size[1] !== 1 || size[2] !== 1)) {
                def.defaults.model = "aabb";
                def.hitboxes = [{ a: [0, 0, 0], b: [...size] }];
                def.hitboxRefs = [def.sizeRef];
            }
        });
    }

    bool("obstacle", (v) => (def.obstacle = v));
    bool("replaceable", (v) => (def.replaceable = v));
    bool("light-passing", (v) => (def.lightPassing = v));
    bool("sky-light-passing", (v) => (def.skyLightPassing = v));
    bool("shadeless", (v) => (def.shadeless = v));
    bool("ambient-occlusion", (v) => (def.ambientOcclusion = v));
    bool("breakable", (v) => (def.breakable = v));
    bool("selectable", (v) => (def.selectable = v));
    bool("grounded", (v) => (def.grounded = v));
    bool("hidden", (v) => (def.hidden = v));
    bool("translucent", (v) => (def.translucent = v));
    bool("solid", (v) => (def.explicitlySolid = v));
}

/** Loads a block from its definition files (first = main file, then overrides). */
export function loadBlockDef(id: string, files: DefText[], getParent: (id: string) => BlockDef | undefined): BlockDef {
    const def = newBlockDef(id);
    for (const file of files) applyBlockFile(def, file, getParent);
    return def;
}

/** ContentBuilder::build runtime info; returns a finalized copy. */
export function finalizeBlock(src: BlockDef): BlockDef {
    const def: BlockDef = { ...src, defaults: cloneVariant(src.defaults), errors: [...src.errors] };
    if (src.variants) def.variants = { ...src.variants, list: src.variants.list.map(cloneVariant) };
    const isSolid = (v: VariantDef) => v.model === "block" || v.culling === "optional";
    if (def.variants) {
        for (const v of def.variants.list) v.solid = isSolid(v) || def.explicitlySolid;
        def.defaults = cloneVariant(def.variants.list[0]);
    } else {
        def.defaults.solid = isSolid(def.defaults) || def.explicitlySolid;
    }
    const EPSILON = 0.01;
    const first = def.hitboxes[0];
    // glm::i8vec3(size + EPSILON) truncates toward zero
    const sizeMatches = first !== undefined && aabbSize(first).every((v, i) => Math.trunc(v + EPSILON) === def.size[i]);
    def.rt = {
        solid: def.defaults.solid && def.obstacle && sizeMatches,
        extended: def.size[0] > 1 || def.size[1] > 1 || def.size[2] > 1,
    };
    return def;
}

/** Number of selectable variant indices (index 0 = root). */
export function variantCount(def: BlockDef): number {
    if (!def.variants) return 1;
    return Math.max(1, Math.min(def.variants.configured, def.variants.mask + 1));
}

/** Block::getVariant(index) */
export function getVariant(def: BlockDef, index: number): VariantDef {
    if (index === 0 || !def.variants) return def.defaults;
    return def.variants.list[index] ?? def.defaults;
}

export function rotationProfile(def: BlockDef): RotationProfile {
    return (def.rotatable && ROTATION_PROFILES[def.profile]) || ROTATION_PROFILES.none;
}

/** Hitboxes as the engine stores them for a rotation (Block::rt.hitboxes). */
export function rotatedHitboxes(def: BlockDef, rotation: number): AABB[] {
    if (!def.rotatable) return def.hitboxes;
    const cs = rotationProfile(def).variants[rotation] ?? IDENTITY;
    return def.hitboxes.map((box) => fixAABB(transformAABB(cs, box)));
}

// ---- geometry ----

/** BlocksRenderer::SUN_VECTOR and DIRECTIONAL_LIGHT_FACTOR (0.3). */
export const BLOCK_SUN: Vec3 = [0.528265, 0.833149, -0.163704];
export const DIRECTIONAL_LIGHT_FACTOR = 0.3;

const v3add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
// 0 - x keeps +0 (no -0 in normals)
const v3neg = (a: Vec3): Vec3 => [0 - a[0], 0 - a[1], 0 - a[2]];
const v3mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const v3normalize = (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

interface Quad {
    corners: [Vec3, Vec3, Vec3, Vec3];
    uvs: [[number, number], [number, number], [number, number], [number, number]];
    normal: Vec3;
}

const FULL_UV: Quad["uvs"] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
];

/**
 * BlocksRenderer::face / faceAO (vector overload): corners
 * coord + (∓X ∓Y + Z) / 2 with UVs (u1,v1) (u2,v1) (u2,v2) (u1,v2).
 */
export function blockFace(coord: Vec3, X: Vec3, Y: Vec3, Z: Vec3): Quad {
    const c = (sx: number, sy: number): Vec3 => v3add(coord, v3scale(v3add(v3add(v3scale(X, sx), v3scale(Y, sy)), Z), 0.5));
    return { corners: [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], uvs: FULL_UV, normal: v3normalize(Z) };
}

/** Pushes a quad as triangles in `index(a..f)` order. */
function pushQuad(mesh: ModelMesh, quad: Quad, order: number[], primitive: number, normal: Vec3 = quad.normal) {
    for (const k of order) {
        mesh.positions.push(...quad.corners[k]);
        mesh.uvs.push(...quad.uvs[k]);
        mesh.normals.push(...normal);
    }
    for (let t = 0; t < order.length / 3; t++) mesh.primitiveIds.push(primitive);
}

/** faceAO / face (vector overload) use index(0, 1, 2, 0, 2, 3). */
const QUAD_ORDER = [0, 1, 2, 0, 2, 3];
/** face (w, h, d overload, X sprites) uses index(0, 1, 3, 1, 2, 3). */
const SPRITE_ORDER = [0, 1, 3, 1, 2, 3];

export interface FaceQuad {
    /** texture-faces index */
    face: number;
    quad: Quad;
}

/** BlocksRenderer::blockCube faces for orientation axes (cell center coord). */
export function cubeFaces(axes: Axes, coord: Vec3 = [0.5, 0.5, 0.5]): FaceQuad[] {
    const [X, Y, Z] = axes;
    return [
        { face: 5, quad: blockFace(coord, X, Y, Z) },
        { face: 4, quad: blockFace(coord, v3neg(X), Y, v3neg(Z)) },
        { face: 3, quad: blockFace(coord, X, v3neg(Z), Y) },
        { face: 2, quad: blockFace(coord, X, Z, v3neg(Y)) },
        { face: 1, quad: blockFace(coord, v3neg(Z), Y, X) },
        { face: 0, quad: blockFace(coord, Z, Y, v3neg(X)) },
    ];
}

/**
 * BlocksRenderer::blockAABB: one box around the union of all hitboxes, the
 * FULL texture on every face (UVs are not cut to the box size), rotated by
 * the orientation and centered on the transformed hitbox center.
 */
export function aabbFaces(hitboxes: AABB[], cs: CoordSystem | undefined): FaceQuad[] {
    if (hitboxes.length === 0) return [];
    let hitbox: AABB = { a: [...hitboxes[0].a], b: [...hitboxes[0].b] };
    for (const box of hitboxes) {
        hitbox = {
            a: [Math.min(hitbox.a[0], box.a[0]), Math.min(hitbox.a[1], box.a[1]), Math.min(hitbox.a[2], box.a[2])],
            b: [Math.max(hitbox.b[0], box.b[0]), Math.max(hitbox.b[1], box.b[1]), Math.max(hitbox.b[2], box.b[2])],
        };
    }
    const size = aabbSize(hitbox);
    let [X, Y, Z]: Axes = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
    ];
    if (cs) {
        [X, Y, Z] = cs.axes;
        hitbox = transformAABB(cs, hitbox);
    }
    // coord -= vec3(0.5) - hitbox.center(), coord being the cell center
    const coord = aabbCenter(hitbox);
    const sx = v3scale(X, size[0]);
    const sy = v3scale(Y, size[1]);
    const sz = v3scale(Z, size[2]);
    return [
        { face: 5, quad: blockFace(coord, sx, sy, sz) },
        { face: 4, quad: blockFace(coord, v3neg(sx), sy, v3neg(sz)) },
        { face: 3, quad: blockFace(coord, sx, v3neg(sz), sy) },
        { face: 2, quad: blockFace(coord, v3neg(sx), v3neg(sz), v3neg(sy)) },
        { face: 1, quad: blockFace(coord, v3neg(sz), sy, sx) },
        { face: 0, quad: blockFace(coord, sz, sy, v3neg(sx)) },
    ];
}

/**
 * BlocksRenderer::blockXSprite: four quads of width 1/1.41, all with normal
 * (0, 1, 0) and a constant 0.8 tint; texture-faces[0] (FACE_MX) on one side
 * of both diagonals, texture-faces[4] (FACE_MZ) on the other. The engine
 * jitters the position by up to ±0.25 per block (hash of x, y, z); the
 * preview uses no jitter. Rotation is ignored by the engine.
 */
export function xSpriteFaces(coord: Vec3 = [0.5, 0.5, 0.5]): FaceQuad[] {
    const w = 1 / 1.41;
    const quad = (axisX: Vec3): Quad => {
        const X = v3scale(axisX, w);
        const Y: Vec3 = [0, 1, 0];
        const c = (sx: number, sy: number): Vec3 => v3add(coord, v3scale(v3add(v3scale(X, sx), v3scale(Y, sy)), 0.5));
        return { corners: [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], uvs: FULL_UV, normal: [0, 1, 0] };
    };
    return [
        { face: 0, quad: quad([-1, 0, 1]) },
        { face: 0, quad: quad([1, 0, 1]) },
        { face: 4, quad: quad([-1, 0, -1]) },
        { face: 4, quad: quad([1, 0, -1]) },
    ];
}

export const X_SPRITE_TINT = 0.8;

// ---- custom models ----

/** UVRegion::scale(-1, 1) around the center on a full region. */
const FLIP_U = (uv: Quad["uvs"]): Quad["uvs"] => uv.map(([u, v]) => [1 - u, v]) as Quad["uvs"];

/** Mesh::addPlane: (pos ∓ right ∓ up), two triangles 0,1,2 / 0,2,3. */
function addPlane(mesh: ModelMesh, pos: Vec3, right: Vec3, up: Vec3, norm: Vec3, uv: Quad["uvs"], prim: number) {
    const c = (sr: number, su: number): Vec3 => v3add(pos, v3add(v3scale(right, sr), v3scale(up, su)));
    pushQuad(mesh, { corners: [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)], uvs: uv, normal: norm }, QUAD_ORDER, prim);
}

/**
 * ModelsGenerator::loadCustomBlockModel / fromCustom (model-primitives).
 * Boxes: [x, y, z, w, h, d, tex] or 6 textures (LEGACY order = FACE_MX..PZ),
 * Mesh::addBox; map_legacy_box_textures flips top/east(+X)/north(+Z) and
 * addBox flips the same faces again, so they cancel out.
 * Tetragons: [x, y, z, rx, ry, rz, ux, uy, uz, tex].
 */
export function legacyCustomModel(primitives: unknown, shading: boolean, errors: ModelError[]): ModelMesh[] {
    const meshes: ModelMesh[] = [];
    if (!isObject(primitives)) return meshes;
    const num = (arr: unknown[], i: number) => (typeof arr[i] === "number" ? (arr[i] as number) : 0);
    const boxes: { a: Vec3; b: Vec3 }[] = [];
    const textures: string[] = [];
    const aabbs = primitives.aabbs;
    if (Array.isArray(aabbs)) {
        for (const box of aabbs) {
            if (!Array.isArray(box)) continue;
            const a: Vec3 = [num(box, 0), num(box, 1), num(box, 2)];
            boxes.push({ a, b: [a[0] + num(box, 3), a[1] + num(box, 4), a[2] + num(box, 5)] });
            if (box.length === 7) textures.push(...Array<string>(6).fill(String(box[6])));
            else if (box.length === 12) textures.push(...box.slice(6, 12).map(String));
            else textures.push(...Array<string>(6).fill("notfound"));
        }
    }
    const points: Vec3[] = [];
    const tetragons = primitives.tetragons;
    if (Array.isArray(tetragons)) {
        for (const t of tetragons) {
            if (!Array.isArray(t)) continue;
            const p: Vec3 = [num(t, 0), num(t, 1), num(t, 2)];
            const xw: Vec3 = [num(t, 3), num(t, 4), num(t, 5)];
            const yh: Vec3 = [num(t, 6), num(t, 7), num(t, 8)];
            points.push(p, v3add(p, xw), v3add(v3add(p, xw), yh), v3add(p, yh));
            textures.push(String(t[9]));
        }
    }
    const X: Vec3 = [1, 0, 0];
    const Y: Vec3 = [0, 1, 0];
    const Z: Vec3 = [0, 0, 1];
    for (let i = 0; i < boxes.length; i++) {
        const center = aabbCenter(boxes[i]);
        const half = v3scale(aabbSize(boxes[i]), 0.5);
        const tex = (face: number) => addMesh(meshes, `blocks:${textures[i * 6 + face]}`, shading);
        // Mesh::addBox(pos, size, uvs, enabled) side by side
        addPlane(tex(0), v3add(center, v3neg(v3mul(X, half))), v3mul(Z, half), v3mul(Y, half), v3neg(X), FULL_UV, -1);
        addPlane(tex(1), v3add(center, v3mul(X, half)), v3neg(v3mul(Z, half)), v3mul(Y, half), X, FLIP_U(FLIP_U(FULL_UV)), -1);
        addPlane(tex(2), v3add(center, v3neg(v3mul(Y, half))), v3mul(X, half), v3mul(Z, half), v3neg(Y), FULL_UV, -1);
        addPlane(tex(3), v3add(center, v3mul(Y, half)), v3mul(X, half), v3neg(v3mul(Z, half)), Y, FLIP_U(FLIP_U(FULL_UV)), -1);
        addPlane(tex(4), v3add(center, v3neg(v3mul(Z, half))), v3neg(v3mul(X, half)), v3mul(Y, half), v3neg(Z), FULL_UV, -1);
        addPlane(tex(5), v3add(center, v3mul(Z, half)), v3mul(X, half), v3mul(Y, half), Z, FLIP_U(FLIP_U(FULL_UV)), -1);
    }
    for (let i = 0; i < points.length / 4; i++) {
        const texture = textures[boxes.length * 6 + i];
        const [v0, v1, v2, v3] = points.slice(i * 4, i * 4 + 4);
        const e1: Vec3 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        const e2: Vec3 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        const norm = v3normalize([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
        const mesh = addMesh(meshes, `blocks:${texture}`, shading);
        pushQuad(mesh, { corners: [v0, v1, v2, v3], uvs: FULL_UV, normal: norm }, QUAD_ORDER, -1);
    }
    if (boxes.length === 0 && points.length === 0) {
        errors.push({ message: "model-primitives has no aabbs or tetragons", severity: "warning" });
    }
    return meshes;
}

/** Engine texture name of a custom model mesh (prepareModel + ContentGfxCache). */
function customMeshTexture(texture: string, faces: string[], warn: (m: string) => void): { texture: string; face?: number } {
    if (texture.startsWith("$")) {
        const index = parseInt(texture.slice(1), 10);
        if (!Number.isFinite(index) || index < 0 || index > 5) {
            warn(`model texture ${texture}: texture-faces index out of range`);
            return { texture: `blocks:${TEXTURE_NOTFOUND}` };
        }
        return { texture: `blocks:${faces[index]}`, face: index };
    }
    const colon = texture.indexOf(":");
    if (colon >= 0) {
        // ContentGfxCache::refreshVariant looks the part after ':' up in the
        // blocks atlas whatever the prefix is
        const name = texture.slice(colon + 1);
        if (!texture.startsWith("blocks:")) warn(`model texture ${texture}: block models only use the blocks atlas ("blocks:${name}")`);
        return { texture: `blocks:${name}` };
    }
    if (texture) warn(`model texture "${texture}" has no atlas prefix: the engine keeps raw UVs over the whole blocks atlas`);
    return { texture };
}

// ---- preview assembly ----

export interface BlockBuildOptions {
    variant?: number;
    rotation?: number;
    /** Loads `models/<name>` (model-name); undefined when no file exists. */
    loadModel?: (name: string) => ModelFile | undefined;
}

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
const dirName = (n: Vec3): string => {
    const i = n.findIndex((c) => Math.abs(c) > 0.5);
    return i < 0 ? "?" : `${n[i] > 0 ? "+" : "-"}${"XYZ"[i]}`;
};

/** Builds the preview of a finalized block definition. */
export function buildBlockModel(src: BlockDef, options: BlockBuildOptions = {}): ModelData {
    const def = src.rt ? src : finalizeBlock(src);
    const errors: ModelError[] = [...def.errors];
    const warn = (message: string) => {
        if (!errors.some((e) => e.message === message)) errors.push({ message, severity: "warning" });
    };
    const count = variantCount(def);
    const variantIndex = Math.min(Math.max(0, Math.trunc(options.variant ?? 0)), count - 1);
    const variant = getVariant(def, variantIndex);
    const profile = rotationProfile(def);
    const rotation = Math.min(Math.max(0, Math.trunc(options.rotation ?? 0)), profile.variants.length - 1);
    const cs = def.rotatable ? profile.variants[rotation] : undefined;
    const axes: Axes = cs ? cs.axes : IDENTITY.axes;
    const shading = !def.shadeless;

    // primitives: one per texture-faces entry with a source, + the model ref
    const primitives: ModelPrimitive[] = [];
    const facePrim: number[] = [];
    for (let i = 0; i < 6; i++) {
        const ref = variant.faceRefs[i];
        if (!ref) {
            facePrim.push(-1);
            continue;
        }
        const prim: ModelPrimitive = { tag: "face", span: ref.span, side: i };
        if (ref.file) prim.file = ref.file;
        facePrim.push(primitives.length);
        primitives.push(prim);
    }
    let modelPrim = -1;
    const modelRef = variant.modelNameRef ?? variant.customRef ?? variant.modelRef;
    if (modelRef) {
        modelPrim = primitives.length;
        const prim: ModelPrimitive = { tag: "model", span: modelRef.span };
        if (modelRef.file) prim.file = modelRef.file;
        primitives.push(prim);
    }

    const meshes: ModelMesh[] = [];
    const overlays: ModelOverlays = { boxes: [], spheres: [], labels: [] };
    const faceMesh = (face: number, tint?: number, shade = shading) => {
        const mesh = addMesh(meshes, `blocks:${variant.textureFaces[face]}`, shade);
        if (tint !== undefined) mesh.tint = tint;
        return mesh;
    };
    const labelFaces = (faces: FaceQuad[]) => {
        for (const { face, quad } of faces) {
            const center = v3scale(quad.corners.reduce((s, c) => v3add(s, c), [0, 0, 0] as Vec3), 0.25);
            overlays.labels.push({
                position: v3add(center, v3scale(quad.normal, 0.02)),
                normal: quad.normal,
                text: `${dirName(quad.normal)} [${face}] ${variant.textureFaces[face]}`,
                face,
            });
        }
    };

    switch (variant.model) {
        case "block": {
            const faces = cubeFaces(axes);
            for (const { face, quad } of faces) pushQuad(faceMesh(face), quad, QUAD_ORDER, facePrim[face]);
            labelFaces(faces);
            break;
        }
        case "aabb": {
            const faces = aabbFaces(def.hitboxes, cs);
            for (const { face, quad } of faces) pushQuad(faceMesh(face), quad, QUAD_ORDER, facePrim[face]);
            labelFaces(faces);
            break;
        }
        case "X": {
            const faces = xSpriteFaces();
            for (const { face, quad } of faces) pushQuad(faceMesh(face, X_SPRITE_TINT, false), quad, SPRITE_ORDER, facePrim[face]);
            // one label per textured side, at the sprite center
            for (const face of [0, 4]) {
                const n = v3normalize(face === 0 ? [-1, 0, -1] : [1, 0, 1]);
                overlays.labels.push({
                    position: v3add([0.5, 0.5, 0.5], v3scale(n, 0.05)),
                    normal: n,
                    text: `[${face}] ${variant.textureFaces[face]}`,
                    face,
                });
            }
            break;
        }
        case "custom": {
            let source: ModelMesh[] = [];
            if (variant.modelName === "") {
                source = legacyCustomModel(variant.customRaw, shading, errors);
            } else {
                const file = options.loadModel?.(variant.modelName);
                if (!file) {
                    errors.push({ message: `could not find model "${variant.modelName}" (models/${variant.modelName}.vec3|.obj|.vcm)`, severity: "error" });
                } else {
                    const stored = storedModels(file).get(variant.modelName);
                    if (stored) {
                        source = stored;
                        if (file.assetName !== variant.modelName) {
                            warn(`model "${variant.modelName}" exists only when another asset loads "${file.assetName}" (blocks request models/${variant.modelName})`);
                        }
                    } else {
                        // shown squashed so the user still sees something
                        source = squashedMeshes(file.data);
                        errors.push({
                            message:
                                file.format === "vcm"
                                    ? `"${variant.modelName}" has bones: the engine stores only "${variant.modelName}.<part>" models and a skeleton, so the block fails to load (set "squash" in preload.json)`
                                    : `"${variant.modelName}": the file defines no model with that name (${[...storedModels(file).keys()].join(", ")})`,
                            severity: "error",
                        });
                    }
                    errors.push(...file.data.errors.filter((e) => e.severity === "error").map((e) => ({ message: `${file.assetName}: ${e.message}`, severity: e.severity })));
                }
            }
            // prepareModel: `$N` → blocks:<texture-faces[N]>; the first atlas
            // texture fills an unassigned texture-faces[0] (iterating in order)
            const faces = [...variant.textureFaces];
            let defaultAssigned = faces[0] !== TEXTURE_NOTFOUND;
            for (const mesh of source) {
                let texture = mesh.texture;
                if (!texture.startsWith("$") && !defaultAssigned && texture && variant.modelName !== "") {
                    const sep = texture.indexOf(":");
                    if (sep >= 0) {
                        faces[0] = texture.slice(sep + 1);
                        defaultAssigned = true;
                    }
                }
                const mapped = customMeshTexture(texture, faces, warn);
                texture = mapped.texture;
                const out = addMesh(meshes, texture, mesh.shading && !def.shadeless);
                const prim = mapped.face !== undefined && facePrim[mapped.face] >= 0 ? facePrim[mapped.face] : modelPrim;
                // blockCustomModel: coord + (v - 0.5) in the orientation axes
                for (let i = 0; i < mesh.positions.length; i += 3) {
                    const p: Vec3 = [mesh.positions[i] - 0.5, mesh.positions[i + 1] - 0.5, mesh.positions[i + 2] - 0.5];
                    out.positions.push(...v3add([0.5, 0.5, 0.5], axisMul(axes, p)));
                    out.normals.push(...axisMul(axes, [mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]]));
                }
                out.uvs.push(...mesh.uvs);
                for (let t = 0; t < mesh.positions.length / 9; t++) out.primitiveIds.push(prim);
            }
            if (source.length === 0 && variant.modelName === "" && variant.customRaw === null) {
                errors.push({ message: "custom model without model-name or model-primitives", severity: "error" });
            }
            break;
        }
        case "none":
            break;
    }
    if (def.translucent) for (const mesh of meshes) mesh.translucent = true;

    // overlays: hitboxes as the engine stores them for this rotation
    const hitboxes = rotatedHitboxes(def, rotation);
    hitboxes.forEach((box, i) => {
        const ref = def.hitboxRefs[i];
        overlays.boxes.push({ kind: "hitbox", min: box.a, max: box.b, label: hitboxes.length > 1 ? `hitbox ${i}` : "hitbox", ...(ref ? { source: ref } : {}) });
    });
    if (def.rt?.extended) {
        let sizeBox: AABB = { a: [0, 0, 0], b: [...def.size] };
        if (cs) sizeBox = fixAABB(transformAABB(cs, sizeBox));
        overlays.boxes.push({ kind: "size", min: sizeBox.a, max: sizeBox.b, label: `size ${def.size.join("×")}`, ...(def.sizeRef ? { source: def.sizeRef } : {}) });
        for (let x = Math.round(sizeBox.a[0]); x < Math.round(sizeBox.b[0]); x++) {
            for (let y = Math.round(sizeBox.a[1]); y < Math.round(sizeBox.b[1]); y++) {
                for (let z = Math.round(sizeBox.a[2]); z < Math.round(sizeBox.b[2]); z++) {
                    overlays.boxes.push({ kind: "cell", min: [x, y, z], max: [x + 1, y + 1, z + 1] });
                }
            }
        }
    }

    const flags: BlockFlag[] = [
        { name: "model", value: variant.model },
        { name: "rotation", value: def.rotatable ? def.profile : "none" },
        { name: "solid (rt)", value: def.rt?.solid ?? false },
        { name: "obstacle", value: def.obstacle },
        { name: "translucent", value: def.translucent },
        { name: "shadeless", value: def.shadeless },
        { name: "light-passing", value: def.lightPassing },
        { name: "sky-light-passing", value: def.skyLightPassing },
        { name: "ambient-occlusion", value: def.ambientOcclusion },
        { name: "culling", value: variant.culling },
        { name: "draw-group", value: variant.drawGroup },
        { name: "selectable", value: def.selectable },
        { name: "replaceable", value: def.replaceable },
        { name: "breakable", value: def.breakable },
        { name: "grounded", value: def.grounded },
        { name: "hidden", value: def.hidden },
    ];
    if (def.material) flags.push({ name: "material", value: def.material });
    if (def.rt?.extended) flags.push({ name: "size", value: def.size.join("×") });

    const info = [
        `block ${def.id}${def.parents.length ? ` (parent ${def.parents.join(" → ")})` : ""}`,
        `model ${variant.model}${variant.modelName ? ` "${variant.modelName}"` : ""}` +
            (count > 1 ? `, variant ${variantIndex}/${count - 1}` : "") +
            (def.rotatable ? `, rotation ${def.profile} #${rotation} (${profile.labels[rotation]})` : ""),
        `texture-faces: ${variant.textureFaces.map((t, i) => `${FACE_NAMES[i]}=${t}`).join(" ")}`,
        `hitbox${hitboxes.length > 1 ? "es" : ""}: ${hitboxes.map((b) => `[${b.a.map(fmt).join(",")}]–[${b.b.map(fmt).join(",")}]`).join(" ")}`,
    ];

    return {
        kind: "block",
        parts: [{ name: "", bone: -1, offset: [0, 0, 0], meshes: meshes.filter((m) => m.positions.length > 0) }],
        bones: [],
        primitives,
        errors,
        info,
        overlays,
        shadingModel: "block",
        block: {
            id: def.id,
            model: variant.model,
            ...(variant.modelName ? { modelName: variant.modelName } : {}),
            variant: variantIndex,
            variantCount: count,
            rotation,
            rotationCount: def.rotatable ? profile.variants.length : 1,
            profile: def.rotatable ? def.profile : "none",
            textureFaces: [...variant.textureFaces],
            emission: [...def.emission],
            flags,
            parents: [...def.parents],
        },
    };
}

/** Model names a block needs (for the host's live-update dependencies). */
export function blockModelNames(def: BlockDef): string[] {
    const names = new Set<string>();
    for (const v of def.variants ? def.variants.list.slice(0, def.variants.configured) : [def.defaults]) {
        if (v.model === "custom" && v.modelName) names.add(v.modelName);
    }
    if (def.defaults.model === "custom" && def.defaults.modelName) names.add(def.defaults.modelName);
    return [...names];
}
