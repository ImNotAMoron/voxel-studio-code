// Entity and skeleton preview (FEATURES.md §5.8): entity definition JSON /
// skeleton JSON / VCM skeleton → ModelData in rest pose.
//
// Ports:
// - src/content/loading/EntityLoader.cpp loadUnit + EntityDef::cloneTo
//   (`parent` copies components, hitbox, sensors and skeleton-name; the
//   child's components and sensors are appended).
// - src/animation/rigging.cpp SkeletonConfig::parse / read_node (pre-order
//   bone indices) and SkeletonConfig::update: bone matrix =
//   parent * translate(offset) * pose, root parent = build_matrix(rot, pos,
//   scale) of the entity transform. In rest pose (pose = identity, entity
//   rotation identity) every bone is a translation by the summed offsets.
// - src/assets/assetload_funcs.cpp skeleton(): a bone model `a.b` loads the
//   model asset `a` (text after the last '.' dropped) and uses the stored
//   model `a.b`; load_vcm_model: a VCM with bones becomes skeleton `<name>`
//   whose bones use models `<name>.<bone>`.
// - src/objects/Entities.cpp spawn: Hitbox(position, hitbox * 0.5), i.e. the
//   hitbox is centered on the transform position; radius sensors are centered
//   on the hitbox position; aabb sensors are local boxes transformed by the
//   transform matrix (AABB::transform keeps them axis-aligned).

import type { JSONPath } from "jsonc-parser";

import { hasVcmSkeleton, storedModels, type ModelFile } from "./assets";
import { asNumber, asString, DefTypeError, isObject, JsonDef, type DefText } from "./jsondef";
import * as m from "./math";
import type { EntityComponentInfo, ModelBone, ModelData, ModelError, ModelOverlays, ModelPart, SourceRef, Vec3 } from "./types";

export const BODY_TYPES = ["static", "kinematic", "dynamic"];

export interface EntityDef {
    id: string;
    components: { name: string; source?: SourceRef }[];
    bodyType: string;
    /** Full hitbox size (EntityDef::hitbox, default 0.25). */
    hitbox: Vec3;
    hitboxRef?: SourceRef;
    boxSensors: { index: number; a: Vec3; b: Vec3; source?: SourceRef }[];
    radialSensors: { index: number; radius: number; source?: SourceRef }[];
    skeletonName: string;
    skeletonRef?: SourceRef;
    parents: string[];
    errors: ModelError[];
}

export function newEntityDef(id: string): EntityDef {
    return {
        id,
        components: [],
        bodyType: "dynamic",
        hitbox: [0.25, 0.25, 0.25],
        boxSensors: [],
        radialSensors: [],
        skeletonName: id,
        parents: [],
        errors: [],
    };
}

function report(def: { errors: ModelError[] }, json: JsonDef, message: string, path: JSONPath, severity: "error" | "warning" = "error") {
    const ref = json.ref(path);
    const error: ModelError = { message: message + (json.file ? ` (in ${json.file})` : ""), severity };
    if (ref && !ref.file) error.span = ref.span;
    def.errors.push(error);
}

function guard(def: { errors: ModelError[] }, json: JsonDef, path: JSONPath, fn: () => void) {
    try {
        fn();
    } catch (err) {
        if (err instanceof DefTypeError) report(def, json, err.message, path);
        else throw err;
    }
}

/** Applies one entity definition file (ContentUnitLoader<EntityDef>::loadUnit). */
export function applyEntityFile(def: EntityDef, source: DefText, getParent: (id: string) => EntityDef | undefined) {
    const json = new JsonDef(source);
    if (!source.file) def.errors.push(...json.errors);
    const root = json.root;
    if (!root) {
        report(def, json, "entity definition must be a JSON object", []);
        return;
    }
    if ("parent" in root) {
        guard(def, json, ["parent"], () => {
            const name = asString(root.parent, "parent");
            const parent = getParent(name);
            if (!parent) {
                report(def, json, `Failed to find parent(${name}) for ${def.id}`, ["parent"]);
                return;
            }
            // EntityDef::cloneTo
            def.components = [...parent.components];
            def.bodyType = parent.bodyType;
            def.hitbox = [...parent.hitbox];
            def.hitboxRef = parent.hitboxRef;
            def.boxSensors = [...parent.boxSensors];
            def.radialSensors = [...parent.radialSensors];
            def.skeletonName = parent.skeletonName;
            def.skeletonRef = parent.skeletonRef;
            def.parents = [name, ...parent.parents];
        });
    }
    const components = root.components;
    if (Array.isArray(components)) {
        components.forEach((elem, i) => {
            guard(def, json, ["components", i], () => {
                const name = isObject(elem) ? asString(elem.name, "component name") : asString(elem, "component");
                const ref = json.ref(isObject(elem) ? ["components", i, "name"] : ["components", i]);
                def.components.push({ name, ...(ref ? { source: ref } : {}) });
            });
        });
    }
    if ("hitbox" in root) {
        guard(def, json, ["hitbox"], () => {
            const arr = root.hitbox;
            if (!Array.isArray(arr)) throw new DefTypeError("hitbox: list expected");
            def.hitbox = [0, 1, 2].map((i) => asNumber(arr[i], "hitbox")) as Vec3;
            def.hitboxRef = json.ref(["hitbox"]);
        });
    }
    const sensors = root.sensors;
    if (Array.isArray(sensors)) {
        sensors.forEach((sensor, i) => {
            guard(def, json, ["sensors", i], () => {
                if (!Array.isArray(sensor)) throw new DefTypeError("sensor: list expected");
                const type = asString(sensor[0], "sensor type");
                const ref = json.ref(["sensors", i]);
                const source = ref ? { source: ref } : {};
                if (type === "aabb") {
                    const n = (k: number) => asNumber(sensor[k], "aabb sensor");
                    def.boxSensors.push({ index: i, a: [n(1), n(2), n(3)], b: [n(4), n(5), n(6)], ...source });
                } else if (type === "radius") {
                    def.radialSensors.push({ index: i, radius: asNumber(sensor[1], "radius sensor"), ...source });
                } else {
                    // logger.error() only
                    report(def, json, `${def.id}: sensor #${i} - unknown type "${type}"`, ["sensors", i, 0], "warning");
                }
            });
        });
    }
    guard(def, json, ["body-type"], () => {
        if ("body-type" in root) {
            const name = asString(root["body-type"], "body-type");
            if (BODY_TYPES.includes(name)) def.bodyType = name;
            else report(def, json, `unknown body-type "${name}" (ignored)`, ["body-type"], "warning");
        }
    });
    guard(def, json, ["skeleton-name"], () => {
        if ("skeleton-name" in root) {
            def.skeletonName = asString(root["skeleton-name"], "skeleton-name");
            def.skeletonRef = json.ref(["skeleton-name"]);
        }
    });
}

export function loadEntityDef(id: string, files: DefText[], getParent: (id: string) => EntityDef | undefined): EntityDef {
    const def = newEntityDef(id);
    for (const file of files) applyEntityFile(def, file, getParent);
    return def;
}

// ---- skeletons ----

export interface SkeletonBone {
    index: number;
    name: string;
    /** Model asset name ("" = no model). */
    model: string;
    offset: Vec3;
    parent: number;
    children: number[];
    source?: SourceRef;
}

export interface SkeletonDef {
    name: string;
    kind: "json" | "model";
    /** Pre-order (engine bone index). */
    bones: SkeletonBone[];
    file?: string;
    errors: ModelError[];
}

/** rigging::SkeletonConfig::parse (read_node). */
export function parseSkeleton(name: string, source: DefText): SkeletonDef {
    const json = new JsonDef(source);
    const skeleton: SkeletonDef = { name, kind: "json", bones: [], ...(source.file ? { file: source.file } : {}), errors: [] };
    if (!source.file) skeleton.errors.push(...json.errors);
    const root = json.root;
    if (!root || !isObject(root.root)) {
        report(skeleton, json, "skeleton: 'root' node object expected", []);
        return skeleton;
    }
    const read = (node: Record<string, unknown>, path: JSONPath, parent: number) => {
        const index = skeleton.bones.length;
        const bone: SkeletonBone = { index, name: "", model: "", offset: [0, 0, 0], parent, children: [] };
        const ref = json.ref(path);
        if (ref) bone.source = ref;
        skeleton.bones.push(bone);
        guard(skeleton, json, [...path, "name"], () => {
            if ("name" in node) bone.name = asString(node.name, "name");
        });
        guard(skeleton, json, [...path, "model"], () => {
            if ("model" in node) bone.model = asString(node.model, "model");
        });
        guard(skeleton, json, [...path, "offset"], () => {
            if ("offset" in node) {
                const arr = node.offset;
                if (!Array.isArray(arr)) throw new DefTypeError("offset: list expected");
                bone.offset = [0, 1, 2].map((i) => asNumber(arr[i], "offset")) as Vec3;
            }
        });
        const nodes = node.nodes;
        if (Array.isArray(nodes)) {
            nodes.forEach((child, i) => {
                if (isObject(child)) {
                    bone.children.push(skeleton.bones.length);
                    read(child, [...path, "nodes", i], index);
                }
            });
        }
    };
    read(root.root, ["root"], -1);
    return skeleton;
}

/** Skeleton of a VCM with bones (load_vcm_model): bone models `<name>.<bone>`. */
export function vcmSkeleton(model: ModelFile): SkeletonDef {
    const bones: SkeletonBone[] = model.data.bones.map((b) => ({
        index: b.index,
        name: b.name,
        model: `${model.assetName}.${b.name}`,
        offset: b.offset,
        parent: b.parent,
        children: [],
        ...(b.span ? { source: { span: b.span, file: model.file } } : {}),
    }));
    bones.sort((a, b) => a.index - b.index);
    for (const bone of bones) if (bone.parent >= 0) bones[bone.parent]?.children.push(bone.index);
    return { name: model.assetName, kind: "model", bones, file: model.file, errors: [] };
}

/** rigging.cpp SkeletonConfig::update in rest pose: world matrix per bone. */
export function boneMatrices(skeleton: SkeletonDef, position: Vec3): m.Mat4[] {
    const matrices: m.Mat4[] = [];
    // build_matrix(rotation = identity, position, scale = 1)
    const rootMatrix = m.translate(m.identity(), position);
    for (const bone of skeleton.bones) {
        const parentMatrix = bone.parent >= 0 ? matrices[bone.parent] : rootMatrix;
        const offset = bone.offset;
        const base = offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2] > 0 ? m.translate(m.identity(), offset) : m.identity();
        matrices[bone.index] = m.mul(parentMatrix, base); // * pose (identity)
    }
    return matrices;
}

// ---- preview assembly ----

export interface EntityHost {
    /** `skeleton-name` → JSON skeleton text, or a model file (VCM skeleton). */
    skeleton(name: string): { kind: "json"; source: DefText } | { kind: "model"; model: ModelFile } | undefined;
    /** Model asset `name` → file `models/<name>.*`. */
    loadModel(name: string): ModelFile | undefined;
    /** Component id → scripts/components/<name>.lua. */
    component?(name: string): string | undefined;
}

export interface SkeletonBuild {
    skeleton?: SkeletonDef;
    kind: "json" | "model" | "missing";
}

/** Resolves a skeleton the way Entities.cpp / the asset loader name them. */
export function resolveSkeleton(name: string, host: EntityHost): SkeletonBuild {
    const found = host.skeleton(name);
    if (!found) return { kind: "missing" };
    if (found.kind === "json") return { kind: "json", skeleton: parseSkeleton(name, found.source) };
    if (!hasVcmSkeleton(found.model)) return { kind: "missing" };
    return { kind: "model", skeleton: vcmSkeleton(found.model) };
}

const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);

/** Renders every bone's model at its rest-pose matrix. */
function skeletonParts(skeleton: SkeletonDef, position: Vec3, host: EntityHost, errors: ModelError[]): { parts: ModelPart[]; bones: ModelBone[] } {
    const matrices = boneMatrices(skeleton, position);
    const parts: ModelPart[] = [];
    const bones: ModelBone[] = [];
    const used = new Set<string>();
    const cache = new Map<string, ModelFile | undefined>();
    const load = (asset: string) => {
        if (!cache.has(asset)) cache.set(asset, host.loadModel(asset));
        return cache.get(asset);
    };
    for (const bone of skeleton.bones) {
        const world = m.transform(matrices[bone.index], [0, 0, 0], 1);
        const origin: Vec3 = [world[0] - position[0], world[1] - position[1], world[2] - position[2]];
        const entry: ModelBone = { name: bone.name, index: bone.index, parent: bone.parent, offset: bone.offset, origin };
        if (bone.model) entry.model = bone.model;
        if (bone.source) {
            entry.span = bone.source.span;
            if (bone.source.file) entry.file = bone.source.file;
        }
        bones.push(entry);
        if (!bone.model) continue;
        // assetload::skeleton: models/<model without the last ".suffix">
        const dot = bone.model.lastIndexOf(".");
        const asset = skeleton.kind === "model" ? skeleton.name : dot >= 0 ? bone.model.slice(0, dot) : bone.model;
        const file = load(asset);
        const meshes = file ? storedModels(file).get(bone.model) : undefined;
        if (!meshes) {
            errors.push({
                message: file
                    ? `bone "${bone.name || "#" + bone.index}": "${asset}" has no model "${bone.model}" (has ${[...storedModels(file).keys()].join(", ")})`
                    : `bone "${bone.name || "#" + bone.index}": model "${bone.model}" not found (models/${asset}.vec3|.obj|.vcm)`,
                severity: "warning",
            });
            continue;
        }
        let name = bone.name || `#${bone.index}`;
        if (used.has(name)) name = `${name}#${bone.index}`;
        used.add(name);
        parts.push({ name, bone: bone.index, offset: world, meshes });
    }
    return { parts, bones };
}

/** Builds the preview of an entity (rest pose, identity rotation). */
export function buildEntityModel(def: EntityDef, host: EntityHost): ModelData {
    const errors: ModelError[] = [...def.errors];
    const position: Vec3 = [0.5, def.hitbox[1] / 2, 0.5];
    const resolved = resolveSkeleton(def.skeletonName, host);
    let parts: ModelPart[] = [];
    let bones: ModelBone[] = [];
    if (resolved.skeleton) {
        errors.push(...resolved.skeleton.errors.map((e) => ({ ...e, span: undefined, message: `skeleton: ${e.message}` })));
        ({ parts, bones } = skeletonParts(resolved.skeleton, position, host, errors));
    } else if (def.skeletonName === def.id) {
        // Entities.cpp: only a warning when the default skeleton is missing
        errors.push({ message: `skeleton ${def.skeletonName} not found (skeletons/${def.skeletonName.split(":").pop()}.json)`, severity: "warning" });
    } else {
        const error: ModelError = { message: `skeleton ${def.skeletonName} not found: the engine throws on spawn`, severity: "error" };
        if (def.skeletonRef && !def.skeletonRef.file) error.span = def.skeletonRef.span;
        errors.push(error);
    }

    const overlays: ModelOverlays = { boxes: [], spheres: [], labels: [] };
    const half = def.hitbox.map((v) => v / 2) as Vec3;
    overlays.boxes.push({
        kind: "entity-hitbox",
        min: [position[0] - half[0], position[1] - half[1], position[2] - half[2]],
        max: [position[0] + half[0], position[1] + half[1], position[2] + half[2]],
        label: "hitbox",
        ...(def.hitboxRef ? { source: def.hitboxRef } : {}),
    });
    for (const s of def.radialSensors) {
        overlays.spheres.push({ kind: "sensor", center: position, radius: s.radius, label: `sensor ${s.index}`, ...(s.source ? { source: s.source } : {}) });
    }
    for (const s of def.boxSensors) {
        overlays.boxes.push({
            kind: "sensor",
            min: [Math.min(s.a[0], s.b[0]) + position[0], Math.min(s.a[1], s.b[1]) + position[1], Math.min(s.a[2], s.b[2]) + position[2]],
            max: [Math.max(s.a[0], s.b[0]) + position[0], Math.max(s.a[1], s.b[1]) + position[1], Math.max(s.a[2], s.b[2]) + position[2]],
            label: `sensor ${s.index}`,
            ...(s.source ? { source: s.source } : {}),
        });
    }
    const components: EntityComponentInfo[] = def.components.map((c) => {
        const file = host.component?.(c.name);
        return { name: c.name, ...(file ? { file } : {}), ...(c.source ? { source: c.source } : {}) };
    });
    for (const c of components) {
        if (!c.file) {
            const error: ModelError = { message: `component ${c.name}: scripts/components/${c.name.split(":").pop()}.lua not found`, severity: "warning" };
            if (c.source && !c.source.file) error.span = c.source.span;
            errors.push(error);
        }
    }
    const info = [
        `entity ${def.id}${def.parents.length ? ` (parent ${def.parents.join(" → ")})` : ""}`,
        `skeleton ${def.skeletonName} (${resolved.kind}), ${bones.length} bones, body ${def.bodyType}`,
        `hitbox ${def.hitbox.map(fmt).join("×")} centered on the entity position (${position.map(fmt).join(", ")})`,
    ];
    if (def.radialSensors.length + def.boxSensors.length > 0) {
        info.push(`${def.radialSensors.length + def.boxSensors.length} sensors (aabb sensors stay axis-aligned when the entity rotates)`);
    }
    return {
        kind: "entity",
        parts,
        bones,
        primitives: [],
        errors,
        info,
        overlays,
        entity: {
            id: def.id,
            skeleton: def.skeletonName,
            skeletonKind: resolved.kind,
            ...(resolved.skeleton?.file ? { skeletonFile: resolved.skeleton.file } : {}),
            bodyType: def.bodyType,
            hitbox: [...def.hitbox],
            components,
            origin: position,
        },
    };
}

/** Preview of a skeleton file alone (skeletons/<name>.json). */
export function buildSkeletonModel(name: string, source: DefText, host: EntityHost): ModelData {
    const skeleton = parseSkeleton(name, source);
    const errors: ModelError[] = [...skeleton.errors];
    const position: Vec3 = [0.5, 0.5, 0.5];
    const { parts, bones } = skeletonParts(skeleton, position, host, errors);
    return {
        kind: "entity",
        parts,
        bones,
        primitives: [],
        errors,
        info: [`skeleton ${name}, ${bones.length} bones`, `root at (${position.map(fmt).join(", ")})`],
        overlays: { boxes: [], spheres: [], labels: [] },
        entity: { id: name, skeleton: name, skeletonKind: "json", components: [], origin: position },
    };
}

