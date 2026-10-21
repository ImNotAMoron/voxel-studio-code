// VCM mesh builder: a port of the engine's src/coders/vcm.cpp (plus
// graphics/commons/Model.cpp, maths/UVRegion.hpp and xml::Attribute
// conversions from src/coders/xml.cpp).
//
// Differences from the engine, all for the benefit of an editor preview:
// - An invalid element is reported in `errors` and skipped; the engine throws
//   and rejects the whole model.
// - Every triangle remembers the element it came from (`primitiveIds`).

import { parseVcm, type Span, type VcmAttribute, type VcmDocument, type VcmElement } from "../vcm/parser";
import * as m from "./math";
import type { Mat4 } from "./math";
import {
    addMesh,
    type ModelBone,
    type ModelData,
    type ModelError,
    type ModelMesh,
    type ModelPart,
    type ModelPrimitive,
    type Vec2,
    type Vec3,
} from "./types";

export const SIDE_INDICES: Readonly<Record<string, number>> = {
    west: 0, // -X
    east: 1, // +X
    bottom: 2, // -Y
    top: 3, // +Y
    north: 4, // -Z
    south: 5, // +Z
};

export const SIDE_NAMES = ["west", "east", "bottom", "top", "north", "south"];

class AttributeError extends Error {
    constructor(message: string, readonly span: Span) {
        super(message);
    }
}

/** `util::parse_double`: leading whitespace, optional '+', then from_chars. */
export function parseDouble(text: string): number {
    let s = text.replace(/^[ \t\n\v\f\r]+/, "");
    if (s.startsWith("+")) {
        s = s.slice(1);
    }
    const match = /^-?(?:inf(?:inity)?|nan(?:\([0-9A-Za-z_]*\))?|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/i.exec(s);
    if (!match) {
        throw new Error("invalid number format");
    }
    const token = match[0].toLowerCase();
    const negative = token.startsWith("-");
    const body = negative ? token.slice(1) : token;
    if (body.startsWith("inf")) return negative ? -Infinity : Infinity;
    if (body.startsWith("nan")) return NaN;
    return Number(token);
}

/** Engine `xml::Attribute` view of a parsed VCM attribute. */
class Attr {
    constructor(readonly attr: VcmAttribute) {}

    get text(): string {
        return this.attr.value;
    }

    private fail(message: string): never {
        throw new AttributeError(`${this.attr.name}: ${message}`, this.attr.valueSpan);
    }

    private num(text: string): number {
        try {
            return parseDouble(text);
        } catch {
            this.fail(`invalid number format in ${JSON.stringify(this.text)}`);
        }
    }

    asVec2(): Vec2 {
        const text = this.text;
        const pos = text.indexOf(",");
        if (pos < 0) {
            const v = this.num(text);
            return [v, v];
        }
        return [this.num(text.slice(0, pos)), this.num(text.slice(pos + 1))];
    }

    asVec3(): Vec3 {
        const text = this.text;
        const pos1 = text.indexOf(",");
        if (pos1 < 0) {
            const v = this.num(text);
            return [v, v, v];
        }
        const pos2 = text.indexOf(",", pos1 + 1);
        if (pos2 < 0) {
            this.fail(`invalid vec3 value "${text}"`);
        }
        // the engine passes extra characters to from_chars, which stops at ','
        return [this.num(text.slice(0, pos1)), this.num(text.slice(pos1 + 1)), this.num(text.slice(pos2 + 1))];
    }

    asVec4(): [number, number, number, number] {
        const text = this.text;
        const pos1 = text.indexOf(",");
        if (pos1 < 0) {
            const v = this.num(text);
            return [v, v, v, v];
        }
        const pos2 = text.indexOf(",", pos1 + 1);
        const pos3 = pos2 < 0 ? -1 : text.indexOf(",", pos2 + 1);
        if (pos2 < 0 || pos3 < 0) {
            this.fail(`invalid vec4 value "${text}"`);
        }
        return [
            this.num(text.slice(0, pos1)),
            this.num(text.slice(pos1 + 1, pos2)),
            this.num(text.slice(pos2 + 1, pos3)),
            this.num(text.slice(pos3 + 1)),
        ];
    }

    /**
     * `Attribute::asNumbers`: fills up to `dst.length` values. After the last
     * number the engine's position wraps around (`npos + 1 == 0`), so a
     * shorter list repeats cyclically: `uv (0.5,0.5)` gives six 0.5s.
     */
    asNumbers(dst: number[]): number {
        const text = this.text;
        let pos = 0;
        let count = 0;
        while (pos < text.length && count < dst.length) {
            const end = text.indexOf(",", pos);
            dst[count++] = this.num(end < 0 ? text.slice(pos) : text.slice(pos, end));
            pos = end < 0 ? 0 : end + 1;
        }
        return count;
    }

    /** `to_boolean` in vcm.cpp. */
    asShading(): boolean {
        return this.text !== "off";
    }
}

/** Engine `xml::Node` view: attributes are a map, so the last one wins. */
class Node {
    readonly attrs = new Map<string, Attr>();

    constructor(readonly element: VcmElement) {
        for (const attr of element.attributes) {
            this.attrs.set(attr.name, new Attr(attr));
        }
    }

    get tag(): string {
        return this.element.tag;
    }

    has(name: string): boolean {
        return this.attrs.has(name);
    }

    attr(name: string): Attr {
        const attr = this.attrs.get(name);
        if (!attr) {
            throw new AttributeError(`element @${this.tag} missing attribute ${name}`, this.element.tagSpan);
        }
        return attr;
    }

    text(name: string, def: string): string {
        return this.attrs.get(name)?.text ?? def;
    }
}

/** maths/UVRegion.hpp */
class UVRegion {
    constructor(public u1 = 0, public v1 = 0, public u2 = 1, public v2 = 1) {}

    clone(): UVRegion {
        return new UVRegion(this.u1, this.v1, this.u2, this.v2);
    }

    scale(x: number, y: number): void {
        const w = this.u2 - this.u1;
        const h = this.v2 - this.v1;
        const cx = (this.u1 + this.u2) * 0.5;
        const cy = (this.v1 + this.v2) * 0.5;
        this.u1 = cx - w * 0.5 * x;
        this.v1 = cy - h * 0.5 * y;
        this.u2 = cx + w * 0.5 * x;
        this.v2 = cy + h * 0.5 * y;
    }

    set(v: readonly number[]): void {
        [this.u1, this.v1, this.u2, this.v2] = v;
    }

    apply(uv: Vec2): Vec2 {
        const w = Math.abs(this.u2 - this.u1);
        const h = Math.abs(this.v2 - this.v1);
        return [this.u1 + uv[0] * w, this.v1 + uv[1] * h];
    }

    /** `operator*(vec2)` */
    scaled(x: number, y: number): UVRegion {
        const copy = this.clone();
        copy.scale(x, y);
        return copy;
    }
}

function pushVertex(mesh: ModelMesh, pos: Vec3, u: number, v: number, norm: Vec3) {
    mesh.positions.push(pos[0], pos[1], pos[2]);
    mesh.uvs.push(u, v);
    mesh.normals.push(norm[0], norm[1], norm[2]);
}

/** Mesh::addPlane(pos, right, up, norm, region, transform) */
function addPlane(
    mesh: ModelMesh, pos: Vec3, right: Vec3, up: Vec3, norm: Vec3, uv: UVRegion, tsf: Mat4, prim: number
) {
    const p = m.transform(tsf, pos, 1);
    const r = m.transform(tsf, right, 0);
    const u = m.transform(tsf, up, 0);
    const n = m.normalize(m.transform(tsf, norm, 0));
    const a = m.sub(m.sub(p, r), u);
    const b = m.sub(m.add(p, r), u);
    const c = m.add(m.add(p, r), u);
    const d = m.add(m.sub(p, r), u);
    pushVertex(mesh, a, uv.u1, uv.v1, n);
    pushVertex(mesh, b, uv.u2, uv.v1, n);
    pushVertex(mesh, c, uv.u2, uv.v2, n);
    pushVertex(mesh, a, uv.u1, uv.v1, n);
    pushVertex(mesh, c, uv.u2, uv.v2, n);
    pushVertex(mesh, d, uv.u1, uv.v2, n);
    mesh.primitiveIds.push(prim, prim);
}

/** Mesh::addRect(pos, right, up, norm, uv, transform) */
function addRect(
    mesh: ModelMesh, pos: Vec3, right: Vec3, up: Vec3, norm: Vec3, uv: UVRegion, tsf: Mat4, prim: number
) {
    const a = m.transform(tsf, m.sub(m.sub(pos, right), up), 1);
    const b = m.transform(tsf, m.sub(m.add(pos, right), up), 1);
    const c = m.transform(tsf, m.add(m.add(pos, right), up), 1);
    const d = m.transform(tsf, m.add(m.sub(pos, right), up), 1);
    // extract_rotation(transform) * vec4(norm, 1.0f): rotation has no translation
    const n = m.transform(m.extractRotation(tsf), norm, 1);
    pushVertex(mesh, a, uv.u1, uv.v1, n);
    pushVertex(mesh, b, uv.u2, uv.v1, n);
    pushVertex(mesh, c, uv.u2, uv.v2, n);
    pushVertex(mesh, a, uv.u1, uv.v1, n);
    pushVertex(mesh, c, uv.u2, uv.v2, n);
    pushVertex(mesh, d, uv.u1, uv.v2, n);
    mesh.primitiveIds.push(prim, prim);
}

const X: Vec3 = [1, 0, 0];
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];
const vmul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];

/** Mesh::addBox(pos, size, uvs, enabledSides, transform) for one side. */
function addBoxSide(
    mesh: ModelMesh, side: number, pos: Vec3, size: Vec3, uvs: UVRegion[], tsf: Mat4, prim: number
) {
    const xs = vmul(X, size), ys = vmul(Y, size), zs = vmul(Z, size);
    switch (side) {
        case 0:
            addPlane(mesh, m.sub(pos, xs), zs, ys, neg(X), uvs[0], tsf, prim);
            break;
        case 1:
            addPlane(mesh, m.add(pos, xs), neg(zs), ys, X, uvs[1].scaled(-1, 1), tsf, prim);
            break;
        case 2:
            addPlane(mesh, m.sub(pos, ys), xs, zs, neg(Y), uvs[2], tsf, prim);
            break;
        case 3:
            addPlane(mesh, m.add(pos, ys), xs, neg(zs), Y, uvs[3].scaled(-1, 1), tsf, prim);
            break;
        case 4:
            addPlane(mesh, m.sub(pos, zs), neg(xs), ys, neg(Z), uvs[4], tsf, prim);
            break;
        case 5:
            addPlane(mesh, m.add(pos, zs), xs, ys, Z, uvs[5].scaled(-1, 1), tsf, prim);
            break;
    }
}

/** ModelBuilder in vcm.cpp */
class ModelBuilder {
    private matrices: Mat4[] = [];
    private combined: Mat4 = m.identity();

    constructor(readonly meshes: ModelMesh[]) {}

    push(matrix: Mat4) {
        this.matrices.push(matrix);
        this.calculate();
    }

    pop() {
        this.matrices.pop();
        this.calculate();
    }

    get transform(): Mat4 {
        return this.combined;
    }

    private calculate() {
        let combined = m.identity();
        for (const matrix of this.matrices) {
            combined = m.mul(combined, matrix);
        }
        this.combined = combined;
    }

    addBoxSide(texture: string, shading: boolean, side: number, pos: Vec3, size: Vec3, uvs: UVRegion[], prim: number) {
        addBoxSide(addMesh(this.meshes, texture, shading), side, pos, size, uvs, this.combined, prim);
    }

    addTriangle(
        texture: string, shading: boolean, a: Vec3, b: Vec3, c: Vec3, norm: Vec3,
        uvA: Vec2, uvB: Vec2, uvC: Vec2, prim: number
    ) {
        const mesh = addMesh(this.meshes, texture, shading);
        // the engine transforms the points but not the normal
        pushVertex(mesh, m.transform(this.combined, a, 1), uvA[0], uvA[1], norm);
        pushVertex(mesh, m.transform(this.combined, b, 1), uvB[0], uvB[1], norm);
        pushVertex(mesh, m.transform(this.combined, c, 1), uvC[0], uvC[1], norm);
        mesh.primitiveIds.push(prim);
    }

    addRect(texture: string, shading: boolean, pos: Vec3, right: Vec3, up: Vec3, norm: Vec3, uv: UVRegion, prim: number) {
        addRect(addMesh(this.meshes, texture, shading), pos, right, up, norm, uv, this.combined, prim);
    }
}

interface BoneNode {
    index: number;
    name: string;
    offset: Vec3;
    children: BoneNode[];
    span?: Span;
}

interface Context {
    parts: Map<string, ModelMesh[]>;
    bones: BoneNode[];
    nextBone: { value: number };
}

/** Rotation from a `rotate` attribute: quaternion with exactly 3 commas, else Euler degrees. */
function applyRotate(tsf: Mat4, attr: Attr): Mat4 {
    const commas = attr.text.split(",").length - 1;
    if (commas === 3) {
        const q = attr.asVec4();
        return m.mul(tsf, m.mat4Cast(q[0], q[1], q[2], q[3]));
    }
    const rot = attr.asVec3();
    tsf = m.rotate(tsf, m.radians(rot[0]), X);
    tsf = m.rotate(tsf, m.radians(rot[1]), Y);
    tsf = m.rotate(tsf, m.radians(rot[2]), Z);
    return tsf;
}

class VcmBuilder {
    readonly primitives: ModelPrimitive[] = [];
    readonly errors: ModelError[] = [];

    private primitive(node: Node, side?: number, partSpans?: Span[]): number {
        const prim: ModelPrimitive = { tag: node.tag, span: node.element.span };
        if (side !== undefined) prim.side = side;
        if (partSpans && partSpans.length) prim.partSpans = partSpans;
        this.primitives.push(prim);
        return this.primitives.length - 1;
    }

    private report(err: unknown, node: Node) {
        if (err instanceof AttributeError) {
            this.errors.push({ message: err.message, span: err.span, severity: "error" });
        } else {
            const message = err instanceof Error ? err.message : String(err);
            this.errors.push({ message, span: node.element.tagSpan, severity: "error" });
        }
    }

    performElement(element: VcmElement, builder: ModelBuilder, ctx: Context) {
        const node = new Node(element);
        try {
            switch (node.tag) {
                case "rect":
                    this.performRect(node, builder);
                    break;
                case "box":
                    this.performBox(node, builder);
                    break;
                case "tri":
                    this.performTriangle(node, builder);
                    break;
                case "bone":
                    this.performBone(node, builder, ctx);
                    break;
                case "part":
                    this.errors.push({
                        message: "@part is only meaningful inside @box",
                        span: element.tagSpan,
                        severity: "warning",
                    });
                    break;
                default:
                    this.errors.push({
                        message: `unknown element @${node.tag} (ignored by the engine)`,
                        span: element.tagSpan,
                        severity: "warning",
                    });
            }
        } catch (err) {
            this.report(err, node);
        }
    }

    private performRect(node: Node, builder: ModelBuilder) {
        let from = node.attr("from").asVec3();
        let right = node.attr("right").asVec3();
        let up = node.attr("up").asVec3();
        let shading = true;

        right = neg(right);
        from = m.sub(from, right);

        const region = new UVRegion();
        if (node.has("region")) {
            region.set(node.attr("region").asVec4());
        } else {
            region.scale(m.length(right), m.length(up));
        }
        if (node.has("region-scale")) {
            region.scale(...node.attr("region-scale").asVec2());
        }
        if (node.has("shading")) {
            shading = node.attr("shading").asShading();
        }

        const flip = node.text("flip", "");
        if (flip === "h") {
            [region.u1, region.u2] = [region.u2, region.u1];
            right = neg(right);
            from = m.sub(from, right);
        } else if (flip === "v") {
            [region.v1, region.v2] = [region.v2, region.v1];
            up = neg(up);
            from = m.sub(from, up);
        }
        const texture = node.text("texture", "$0");

        let normal: Vec3;
        if (node.has("normal")) {
            normal = node.attr("normal").asVec3();
        } else {
            normal = m.cross(m.normalize(right), m.normalize(up));
        }

        const prim = this.primitive(node);
        const center = m.add(m.add(from, m.mulScalar(right, 0.5)), m.mulScalar(up, 0.5));
        const cullFace = node.text("cull-face", "back");
        if (cullFace === "front") {
            normal = neg(normal);
        } else if (cullFace === "off") {
            builder.addRect(texture, shading, center, m.mulScalar(right, 0.5), m.mulScalar(up, 0.5), normal, region, prim);
            builder.addRect(texture, shading, center, m.mulScalar(right, -0.5), m.mulScalar(up, -0.5), neg(normal), region, prim);
            return;
        }
        builder.addRect(texture, shading, center, m.mulScalar(right, 0.5), m.mulScalar(up, 0.5), normal, region, prim);
    }

    private performTriangle(node: Node, builder: ModelBuilder) {
        let a = node.attr("a").asVec3();
        let b = node.attr("b").asVec3();
        let c = node.attr("c").asVec3();

        let uvs: Vec2[] = [[0, 0], [1, 0], [1, 1]];

        let shading = true;
        if (node.has("shading")) {
            shading = node.attr("shading").asShading();
        }

        let normal: Vec3;
        if (node.has("normal")) {
            normal = node.attr("normal").asVec3();
        } else {
            normal = m.normalize(m.cross(m.sub(b, a), m.sub(c, a)));
        }

        if (node.has("uv")) {
            const flat = [0, 0, 1, 0, 1, 1];
            node.attr("uv").asNumbers(flat);
            uvs = [[flat[0], flat[1]], [flat[2], flat[3]], [flat[4], flat[5]]];
        } else {
            const region = new UVRegion();
            if (node.has("region")) {
                region.set(node.attr("region").asVec4());
            }
            if (node.has("region-scale")) {
                region.scale(...node.attr("region-scale").asVec2());
            }
            uvs = uvs.map((uv) => region.apply(uv));
        }

        const texture = node.text("texture", "$0");
        const prim = this.primitive(node);

        const cullFace = node.text("cull-face", "back");
        if (cullFace === "front") {
            [b, c] = [c, b];
            [uvs[1], uvs[2]] = [uvs[2], uvs[1]];
            normal = neg(normal);
        } else if (cullFace === "off") {
            builder.addTriangle(texture, shading, a, b, c, normal, uvs[0], uvs[1], uvs[2], prim);
            builder.addTriangle(texture, shading, a, c, b, neg(normal), uvs[0], uvs[2], uvs[1], prim);
            return;
        }
        builder.addTriangle(texture, shading, a, b, c, normal, uvs[0], uvs[1], uvs[2], prim);
    }

    private performBox(node: Node, builder: ModelBuilder) {
        let from = node.attr("from").asVec3();
        let to = node.attr("to").asVec3();

        let origin = m.mulScalar(m.add(from, to), 0.5);
        if (node.has("origin")) {
            origin = node.attr("origin").asVec3();
        }

        from = m.sub(from, origin);
        to = m.sub(to, origin);
        let tsf = m.translate(m.identity(), origin);

        if (node.has("rotate")) {
            tsf = applyRotate(tsf, node.attr("rotate"));
        }

        const regions = Array.from({ length: 6 }, () => new UVRegion());
        regions[0].scale(to[2] - from[2], to[1] - from[1]);
        regions[1].scale(from[2] - to[2], to[1] - from[1]);
        regions[2].scale(to[0] - from[0], to[2] - from[2]);
        regions[3].scale(from[0] - to[0], to[2] - from[2]);
        regions[4].scale(to[0] - from[0], to[1] - from[1]);
        regions[5].scale(from[0] - to[0], to[1] - from[1]);

        const center = m.mulScalar(m.add(from, to), 0.5);
        const halfsize = m.mulScalar(m.sub(to, from), 0.5);

        let shading = true;
        const texfaces = ["$0", "$1", "$2", "$3", "$4", "$5"];
        if (node.has("texture")) {
            texfaces.fill(node.attr("texture").text);
        }
        if (node.has("shading")) {
            shading = node.attr("shading").asShading();
        }

        const partSpans: Span[][] = [[], [], [], [], [], []];
        for (const child of node.element.children) {
            if (child.tag !== "part") {
                this.errors.push({
                    message: `@${child.tag} inside @box is ignored by the engine`,
                    span: child.tagSpan,
                    severity: "warning",
                });
                continue;
            }
            const part = new Node(child);
            try {
                const tags = part.attr("tags").text.split(",");
                for (const rawTag of tags) {
                    const tag = rawTag.trim();
                    const idx = SIDE_INDICES[tag];
                    if (idx === undefined || !Object.hasOwn(SIDE_INDICES, tag)) {
                        this.errors.push({
                            message: `unknown side '${tag}' (expected ${SIDE_NAMES.join(", ")})`,
                            span: part.attr("tags").attr.valueSpan,
                            severity: "warning",
                        });
                        continue;
                    }
                    partSpans[idx].push(child.span);
                    if (part.has("texture")) {
                        texfaces[idx] = part.attr("texture").text;
                    }
                    if (part.has("region")) {
                        const region = part.attr("region").asVec4();
                        if (idx % 2 === 1) {
                            [region[0], region[2]] = [region[2], region[0]];
                        }
                        regions[idx].set(region);
                    }
                    if (part.has("region-scale")) {
                        regions[idx].scale(...part.attr("region-scale").asVec2());
                    }
                }
            } catch (err) {
                // the engine aborts the whole model here
                this.report(err, part);
            }
        }

        const deleted = [false, false, false, false, false, false];
        if (node.has("delete")) {
            for (const rawName of node.attr("delete").text.split(",")) {
                const name = rawName.trim();
                if (Object.hasOwn(SIDE_INDICES, name)) {
                    deleted[SIDE_INDICES[name]] = true;
                } else {
                    this.errors.push({
                        message: `unknown side '${name}' (expected ${SIDE_NAMES.join(", ")})`,
                        span: node.attr("delete").attr.valueSpan,
                        severity: "warning",
                    });
                }
            }
        }

        builder.push(tsf);
        for (let i = 0; i < 6; i++) {
            if (deleted[i]) {
                continue;
            }
            const prim = this.primitive(node, i, partSpans[i]);
            builder.addBoxSide(texfaces[i], shading, i, center, halfsize, regions, prim);
        }
        builder.pop();
    }

    private performBone(node: Node, builder: ModelBuilder, ctx: Context) {
        const name = node.text("name", "");

        let movement: Vec3 = [0, 0, 0];
        let tsf = m.identity();
        if (node.has("move")) {
            movement = node.attr("move").asVec3();
        }
        if (node.has("rotate")) {
            tsf = applyRotate(tsf, node.attr("rotate"));
        }
        if (node.has("scale")) {
            tsf = m.scale(tsf, node.attr("scale").asVec3());
        }

        if (name === "") {
            tsf = m.translate(tsf, movement);
            builder.push(tsf);
            for (const child of node.element.children) {
                this.performElement(child, builder, ctx);
            }
            builder.pop();
            return;
        }
        const origin = m.transform(builder.transform, movement, 1);
        const boneIndex = ctx.nextBone.value++;
        tsf = m.mul(builder.transform, tsf);

        const bones: BoneNode[] = [];
        const boneContext: Context = { parts: ctx.parts, bones, nextBone: ctx.nextBone };
        const meshes: ModelMesh[] = [];
        const boneBuilder = new ModelBuilder(meshes);
        boneBuilder.push(tsf);
        for (const child of node.element.children) {
            this.performElement(child, boneBuilder, boneContext);
        }
        ctx.bones.push({ index: boneIndex, name, offset: origin, children: bones, span: node.element.span });
        if (ctx.parts.has(name)) {
            this.errors.push({
                message: `duplicate bone name '${name}': the engine keeps only the last part`,
                span: node.attr("name").attr.valueSpan,
                severity: "warning",
            });
        }
        ctx.parts.set(name, meshes);
    }
}

/** Builds the mesh data of a VCM document (`vcm::parse` + parts/skeleton). */
export function buildVcmModel(doc: VcmDocument): ModelData {
    const builder = new VcmBuilder();
    const parts = new Map<string, ModelMesh[]>();
    const rootMeshes: ModelMesh[] = [];
    const rootBuilder = new ModelBuilder(rootMeshes);
    const bones: BoneNode[] = [];
    const ctx: Context = { parts, bones, nextBone: { value: 1 } };

    for (const element of doc.elements) {
        builder.performElement(element, rootBuilder, ctx);
    }
    parts.set("root", rootMeshes);

    // skeleton: nodes indexed by bone index (pre-order), offsets accumulated
    // like calc_offsets in VcmModel::squash
    const root: BoneNode = { index: 0, name: "root", offset: [0, 0, 0], children: bones };
    const boneList: ModelBone[] = [];
    const visit = (bone: BoneNode, parent: number, parentOrigin: Vec3) => {
        const origin = parent < 0 ? bone.offset : m.add(parentOrigin, bone.offset);
        const entry: ModelBone = {
            name: bone.name,
            index: bone.index,
            parent,
            offset: bone.offset,
            origin,
        };
        if (bone.span) entry.span = bone.span;
        boneList[bone.index] = entry;
        for (const child of bone.children) {
            visit(child, bone.index, origin);
        }
    };
    visit(root, -1, [0, 0, 0]);

    const modelParts: ModelPart[] = [];
    for (const [name, meshes] of parts) {
        // SkeletonConfig::find returns the first bone with that name
        const bone = boneList.find((b) => b && b.name === name);
        modelParts.push({
            name,
            bone: bone ? bone.index : -1,
            offset: bone ? bone.origin : [0, 0, 0],
            meshes,
        });
    }
    // display order: by bone index
    modelParts.sort((a, b) => a.bone - b.bone);

    const errors: ModelError[] = doc.errors.map((e) => ({ message: e.message, span: e.span, severity: "error" }));
    errors.push(...builder.errors);
    let triangles = 0;
    for (const part of modelParts) {
        for (const mesh of part.meshes) triangles += mesh.positions.length / 9;
    }
    return {
        kind: "vcm",
        parts: modelParts,
        bones: boneList.filter((b) => b !== undefined),
        primitives: builder.primitives,
        errors,
        info: [
            `${builder.primitives.length} primitives, ${triangles} triangles`,
            `${boneList.length} bones: ${boneList.map((b) => b.name).join(", ")}`,
        ],
    };
}

/** Parses VCM text and builds its meshes. */
export function buildVcmModelFromText(text: string): ModelData {
    return buildVcmModel(parseVcm(text));
}
