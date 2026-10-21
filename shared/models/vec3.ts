// VEC3 binary model reader: a port of src/coders/vec3.cpp
// (doc/specs/vec3_model_spec.md). Each vec3 model becomes a part whose
// vertices are local (position - origin, as the engine stores them) and whose
// `offset` is the origin (what the engine adds back when squashing).

import type { ModelData, ModelError, ModelMesh, ModelPart, Vec3 } from "./types";

const VERSION = 1;
const FLAG_ZLIB = 0x1;
const FLAG_16BIT_INDICES = 0x2;
const SHADELESS = 1;
const ATTRIBUTE_NAMES = ["position", "uv", "normal", "color"];

export interface Vec3Material {
    flags: number;
    name: string;
}

export interface Vec3Attribute {
    type: number;
    flags: number;
    data: Float32Array;
}

class Reader {
    pos = 0;
    private view: DataView;

    constructor(readonly bytes: Uint8Array) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    need(size: number) {
        if (this.pos + size > this.bytes.length) {
            throw new Error(`buffer underflow at byte ${this.pos}`);
        }
    }

    u8(): number {
        this.need(1);
        return this.bytes[this.pos++];
    }

    i16(): number {
        this.need(2);
        const v = this.view.getInt16(this.pos, true);
        this.pos += 2;
        return v;
    }

    i32(): number {
        this.need(4);
        const v = this.view.getInt32(this.pos, true);
        this.pos += 4;
        return v;
    }

    f32(): number {
        this.need(4);
        const v = this.view.getFloat32(this.pos, true);
        this.pos += 4;
        return v;
    }

    floats(byteSize: number): Float32Array {
        this.need(byteSize);
        const count = Math.floor(byteSize / 4);
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            out[i] = this.view.getFloat32(this.pos + i * 4, true);
        }
        this.pos += byteSize;
        return out;
    }

    string(length: number): string {
        this.need(length);
        const bytes = this.bytes.subarray(this.pos, this.pos + length);
        this.pos += length;
        return new TextDecoder().decode(bytes);
    }
}

function loadAttribute(reader: Reader): Vec3Attribute {
    const type = reader.u8();
    const flags = reader.u8();
    if (flags !== 0) {
        throw new Error("attribute compression is not supported yet");
    }
    const size = reader.i32();
    if (size < 0) throw new Error(`invalid attribute size ${size}`);
    return { type, flags, data: reader.floats(size) };
}

function buildMesh(attrs: Vec3Attribute[], indices: Uint16Array, material: Vec3Material): ModelMesh {
    let coords: Float32Array | undefined;
    let uvs: Float32Array | undefined;
    let normals: Float32Array | undefined;
    let coordsIndex = 0, uvsIndex = 0, normalsIndex = 0;
    attrs.forEach((attr, i) => {
        switch (attr.type) {
            case 0:
                coords = attr.data;
                coordsIndex = i;
                break;
            case 1:
                uvs = attr.data;
                uvsIndex = i;
                break;
            case 2:
                normals = attr.data;
                normalsIndex = i;
                break;
        }
    });
    const get = (data: Float32Array, index: number, size: number, what: string): number[] => {
        if ((index + 1) * size > data.length) {
            throw new Error(`${what} index ${index} out of range`);
        }
        return Array.from(data.subarray(index * size, index * size + size));
    };
    const mesh: ModelMesh = {
        texture: material.name,
        shading: (material.flags & SHADELESS) === 0,
        positions: [],
        uvs: [],
        normals: [],
        primitiveIds: [],
    };
    const stride = attrs.length;
    const verticesCount = Math.floor(indices.length / stride);
    for (let i = 0; i < verticesCount; i++) {
        const coord = coords ? get(coords, indices[i * stride + coordsIndex], 3, "position") : [0, 0, 0];
        const uv = uvs ? get(uvs, indices[i * stride + uvsIndex], 2, "uv") : [0, 0];
        let normal: number[] = [0, 0, 0];
        if (normals) {
            normal = get(normals, indices[i * stride + normalsIndex], 3, "normal");
        } else if (coords) {
            // flat normal
            const idx = Math.floor(i / 3) * 3;
            const a = get(coords, indices[idx * stride + coordsIndex], 3, "position");
            const b = get(coords, indices[(idx + 1) * stride + coordsIndex], 3, "position");
            const c = get(coords, indices[(idx + 2) * stride + coordsIndex], 3, "position");
            const ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const ca = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const n = [ba[1] * ca[2] - ca[1] * ba[2], ba[2] * ca[0] - ca[2] * ba[0], ba[0] * ca[1] - ca[0] * ba[1]];
            const len = Math.hypot(n[0], n[1], n[2]);
            normal = [n[0] / len, n[1] / len, n[2] / len];
        }
        mesh.positions.push(...coord);
        mesh.uvs.push(...uv);
        mesh.normals.push(...normal);
        if (i % 3 === 0) mesh.primitiveIds.push(-1);
    }
    return mesh;
}

interface LoadedMesh {
    mesh: ModelMesh;
    attributes: string[];
    triangles: number;
}

function loadMesh(reader: Reader, materials: Vec3Material[]): LoadedMesh {
    const triangleCount = reader.i32();
    const materialId = reader.i16();
    const flags = reader.i16();
    const attributeCount = reader.i16();
    if (flags === FLAG_ZLIB) {
        throw new Error("compression is not supported yet");
    }
    if (attributeCount <= 0) {
        throw new Error("mesh must have at least one attribute");
    }
    const attributes: Vec3Attribute[] = [];
    for (let i = 0; i < attributeCount; i++) {
        attributes.push(loadAttribute(reader));
    }
    const count = triangleCount * 3 * attributeCount;
    const indices = new Uint16Array(count);
    if ((flags & FLAG_16BIT_INDICES) === 0) {
        for (let i = 0; i < count; i++) indices[i] = reader.u8();
    } else {
        for (let i = 0; i < count; i++) indices[i] = reader.i16() & 0xffff;
    }
    const material = materials[materialId];
    if (!material) {
        throw new Error(`material index ${materialId} out of range`);
    }
    return {
        mesh: buildMesh(attributes, indices, material),
        attributes: attributes.map((a) => ATTRIBUTE_NAMES[a.type] ?? `#${a.type}`),
        triangles: triangleCount,
    };
}

export interface Vec3File {
    version: number;
    materials: Vec3Material[];
    models: { name: string; origin: Vec3; meshes: LoadedMesh[] }[];
}

/** `vec3::load`. Throws on malformed input, like the engine. */
export function loadVec3(bytes: Uint8Array): Vec3File {
    const reader = new Reader(bytes);
    const magic = [0, 0, 86, 69, 67, 51, 0, 0]; // "\0\0VEC3\0\0"
    if (bytes.length <= magic.length || magic.some((b, i) => bytes[i] !== b)) {
        throw new Error("invalid magic number");
    }
    reader.pos = magic.length;
    const version = reader.i16();
    reader.i16(); // reserved
    if (version > VERSION) {
        throw new Error("unsupported VEC3 version");
    }
    const materialCount = reader.i16();
    const modelCount = reader.i16();
    const materials: Vec3Material[] = [];
    for (let i = 0; i < materialCount; i++) {
        const flags = reader.i16();
        const nameLength = reader.i16();
        materials.push({ flags, name: reader.string(Math.max(0, nameLength)) });
    }
    const models: Vec3File["models"] = [];
    for (let i = 0; i < modelCount; i++) {
        const nameLength = reader.i16();
        const origin: Vec3 = [reader.f32(), reader.f32(), reader.f32()];
        const meshCount = reader.i32();
        const meshes: LoadedMesh[] = [];
        for (let j = 0; j < meshCount; j++) {
            meshes.push(loadMesh(reader, materials));
        }
        const name = reader.string(Math.max(0, nameLength));
        for (const { mesh } of meshes) {
            const p = mesh.positions;
            for (let k = 0; k < p.length; k += 3) {
                p[k] = Math.fround(p[k] - origin[0]);
                p[k + 1] = Math.fround(p[k + 1] - origin[1]);
                p[k + 2] = Math.fround(p[k + 2] - origin[2]);
            }
        }
        // std::unordered_map: a later model with the same name replaces it
        const existing = models.findIndex((model) => model.name === name);
        if (existing >= 0) models.splice(existing, 1);
        models.push({ name, origin, meshes });
    }
    return { version, materials, models };
}

/** Builds preview data from a .vec3 file; errors are reported, not thrown. */
export function buildVec3Model(bytes: Uint8Array): ModelData {
    let file: Vec3File;
    try {
        file = loadVec3(bytes);
    } catch (err) {
        const errors: ModelError[] = [{ message: err instanceof Error ? err.message : String(err), severity: "error" }];
        return { kind: "vec3", parts: [], bones: [], primitives: [], errors, info: [] };
    }
    const parts: ModelPart[] = file.models.map((model) => ({
        name: model.name,
        bone: -1,
        offset: model.origin,
        meshes: model.meshes.map((m) => m.mesh),
    }));
    const fmt = (v: number) => String(Math.round(v * 1e4) / 1e4);
    const info = [
        `VEC3 version ${file.version}, ${file.materials.length} materials, ${file.models.length} models`,
        ...file.materials.map(
            (mat, i) => `material ${i}: "${mat.name}"${mat.flags & SHADELESS ? " (shadeless)" : ""}`
        ),
        ...file.models.map(
            (model) =>
                `model "${model.name}" origin (${model.origin.map(fmt).join(", ")}): ` +
                model.meshes
                    .map((m) => `${m.triangles} tris [${m.attributes.join(", ")}] → ${m.mesh.texture}`)
                    .join("; ")
        ),
    ];
    return { kind: "vec3", parts, bones: [], primitives: [], errors: [], info };
}
