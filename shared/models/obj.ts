// Wavefront OBJ mesh builder: a port of src/coders/obj.cpp (and the
// BasicParser primitives it uses), including its quirks:
// - `.mtl` files are ignored; the `usemtl` name is the texture name.
// - Faces before the first `usemtl` are skipped, so a file without `usemtl`
//   produces an empty model.
// - Polygons are triangulated as a fan around the first vertex.
// - Missing uv/normal indices use index 0: uv (0,0), normal (0,1,0).
// - Negative (relative) indices are not supported.
// Engine parse errors abort the whole model; here they are reported and the
// geometry parsed so far is kept.

import { addMesh, type ModelData, type ModelError, type ModelMesh, type Vec2, type Vec3 } from "./types";

class ObjError extends Error {
    constructor(message: string, readonly pos: number) {
        super(message);
    }
}

const isWhitespace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isIdentifierStart = (c: string) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
const isIdentifierPart = (c: string) => isIdentifierStart(c) || isDigit(c) || c === "-";

function hexchar2int(c: string | undefined): number {
    if (c === undefined) return -1;
    if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
    if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
    if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55;
    return -1;
}

interface Vertex {
    coord: Vec3;
    uv: Vec2;
    normal: Vec3;
}

class ObjParser {
    pos = 0;
    coords: Vec3[] = [[0, 0, 0]];
    uvs: Vec2[] = [[0, 0]];
    normals: Vec3[] = [[0, 1, 0]];
    warnings: ModelError[] = [];

    constructor(readonly src: string) {}

    hasNext() {
        return this.pos < this.src.length;
    }

    error(message: string): ObjError {
        return new ObjError(message, this.pos);
    }

    skipWhitespace() {
        while (this.hasNext() && isWhitespace(this.src[this.pos])) this.pos++;
    }

    skipLine() {
        while (this.hasNext()) {
            if (this.src[this.pos++] === "\n") break;
        }
    }

    /** Skips whitespace (and newlines); undefined at the end of input. */
    peek(): string | undefined {
        this.skipWhitespace();
        return this.hasNext() ? this.src[this.pos] : undefined;
    }

    /** Skips whitespace except newlines; undefined at the end of input. */
    peekInLine(): string | undefined {
        while (this.hasNext()) {
            const c = this.src[this.pos];
            if (c === "\n") return c;
            if (isWhitespace(c)) this.pos++;
            else break;
        }
        return this.hasNext() ? this.src[this.pos] : undefined;
    }

    readUntilEOL(): string {
        const start = this.pos;
        while (this.hasNext() && this.src[this.pos] !== "\n") this.pos++;
        let end = this.pos;
        if (end > start && this.src[end - 1] === "\r") end--;
        return this.src.slice(start, end);
    }

    parseName(): string {
        const c = this.peek();
        if (c === undefined || !isIdentifierStart(c)) {
            throw this.error("identifier expected");
        }
        const start = this.pos;
        while (this.hasNext() && isIdentifierPart(this.src[this.pos])) this.pos++;
        return this.src.slice(start, this.pos);
    }

    parseSimpleInt(base: number): number {
        const c = this.peek();
        let index = hexchar2int(c);
        if (index === -1 || index >= base) {
            throw this.error("invalid number literal");
        }
        let value = index;
        this.pos++;
        while (this.hasNext()) {
            while (this.src[this.pos] === "_") this.pos++;
            index = hexchar2int(this.src[this.pos]);
            if (index === -1 || index >= base) return value;
            value = value * base + index;
            this.pos++;
        }
        return value;
    }

    /** BasicParser::parseNumber */
    parseNumber(): number {
        let sign = 1;
        const first = this.peek();
        if (first === "-") {
            this.pos++;
            sign = -1;
        } else if (first === "+") {
            this.pos++;
        }
        const c = this.peek();
        const src = this.src;
        if (c === "0" && this.pos + 1 < src.length && "bBoOxX".includes(src[this.pos + 1])) {
            const base = "bB".includes(src[this.pos + 1]) ? 2 : "oO".includes(src[this.pos + 1]) ? 8 : 16;
            this.pos += 2;
            return this.parseSimpleInt(base);
        }
        if (c === "i" && src.startsWith("inf", this.pos) && this.pos + 2 < src.length) {
            this.pos += 3;
            return Infinity * sign;
        }
        if (c === "n" && src.startsWith("nan", this.pos) && this.pos + 2 < src.length) {
            this.pos += 3;
            return NaN;
        }
        const start = this.pos;
        this.parseSimpleInt(10);
        if (this.hasNext() && (src[this.pos] === "e" || src[this.pos] === "E")) {
            return sign * this.exponent(Number(src.slice(start, this.pos)));
        }
        if (this.hasNext() && src[this.pos] === ".") {
            this.pos++;
            while (this.hasNext() && isDigit(src[this.pos])) this.pos++;
            const value = Number(src.slice(start, this.pos).replace(/_/g, ""));
            if (this.hasNext() && (src[this.pos] === "e" || src[this.pos] === "E")) {
                return sign * this.exponent(value);
            }
            return sign * value;
        }
        return sign * Number(src.slice(start, this.pos).replace(/_/g, ""));
    }

    private exponent(value: number): number {
        this.pos++;
        let s = 1;
        const c = this.peek();
        if (c === "-") {
            s = -1;
            this.pos++;
        } else if (c === "+") {
            this.pos++;
        }
        return value * Math.pow(10, s * this.parseSimpleInt(10));
    }

    parseVec3(): Vec3 {
        const x = Math.fround(this.parseNumber());
        const y = Math.fround(this.parseNumber());
        const z = Math.fround(this.parseNumber());
        return [x, y, z];
    }

    parseVec2(): Vec2 {
        const x = Math.fround(this.parseNumber());
        const y = Math.fround(this.parseNumber());
        return [x, y];
    }

    collectVertexData() {
        while (this.hasNext()) {
            const c = this.peek();
            if (c === undefined) return;
            if (c === "#") {
                this.skipLine();
                continue;
            }
            const cmd = this.parseName();
            if (cmd === "v") {
                this.coords.push(this.parseVec3());
            } else if (cmd === "vt") {
                this.uvs.push(this.parseVec2());
            } else if (cmd === "vn") {
                this.normals.push(this.parseVec3());
            } else {
                this.skipLine();
            }
        }
    }

    lookup<T>(list: T[], index: number, what: string): T {
        if (index >= list.length) {
            throw this.error(`${what} index ${index} out of range (${list.length - 1} defined)`);
        }
        return list[index];
    }

    parseFaceVertex(): Vertex {
        const parseIndex = () => {
            if (!this.hasNext() || !isDigit(this.peekInLine())) return 0;
            return this.parseSimpleInt(10);
        };
        this.peekInLine();
        const start = this.pos;
        const coord = parseIndex();
        let uv = 0;
        let normal = 0;
        if (this.hasNext() && this.peekInLine() === "/") {
            this.pos++;
            uv = parseIndex();
            if (this.hasNext() && this.peekInLine() === "/") {
                this.pos++;
                normal = parseIndex();
            }
        }
        if (this.pos === start) {
            // the engine loops forever here (e.g. negative indices)
            throw this.error(`unsupported face vertex '${this.src[this.pos]}'`);
        }
        return {
            coord: this.lookup(this.coords, coord, "vertex"),
            uv: this.lookup(this.uvs, uv, "uv"),
            normal: this.lookup(this.normals, normal, "normal"),
        };
    }

    parseFace(mesh: ModelMesh) {
        const vertices: Vertex[] = [];
        while (this.hasNext()) {
            const c = this.peekInLine();
            if (c === undefined || c === "\n") break;
            vertices.push(this.parseFaceVertex());
        }
        for (let j = 0; j + 2 < vertices.length; j++) {
            for (const v of [vertices[0], vertices[j + 1], vertices[j + 2]]) {
                mesh.positions.push(...v.coord);
                mesh.uvs.push(...v.uv);
                mesh.normals.push(...v.normal);
            }
            mesh.primitiveIds.push(-1);
        }
    }

    buildMeshes(meshes: ModelMesh[]) {
        let texture = "";
        let found = false;
        while (this.hasNext()) {
            const c = this.peek();
            if (c === undefined) break;
            if (c !== "#" && this.parseName() === "usemtl") {
                this.skipWhitespace();
                texture = this.readUntilEOL();
                found = true;
                break;
            }
            this.skipLine();
        }
        if (!found) {
            this.warnings.push({
                message: "no 'usemtl' in the file: the engine skips faces before the first usemtl",
                severity: "warning",
            });
        }
        do {
            let mesh = addMesh(meshes, texture);
            while (this.hasNext()) {
                const c = this.peek();
                if (c === undefined) break;
                if (c === "#") {
                    this.skipLine();
                    continue;
                }
                const cmd = this.parseName();
                if (cmd === "usemtl") {
                    this.skipWhitespace();
                    texture = this.readUntilEOL();
                    mesh = addMesh(meshes, texture);
                    break;
                } else if (cmd === "f") {
                    this.parseFace(mesh);
                }
                this.skipLine();
            }
        } while (this.hasNext());
    }
}

/** Line/column-free span helper: an error at `pos` covers one character. */
function errorAt(message: string, pos: number, length: number): ModelError {
    return { message, span: { start: Math.min(pos, Math.max(0, length - 1)), end: Math.min(pos + 1, length) }, severity: "error" };
}

/** Builds the mesh data of an OBJ file (`obj::parse`). */
export function buildObjModel(text: string): ModelData {
    const parser = new ObjParser(text);
    const errors: ModelError[] = [];
    try {
        parser.collectVertexData();
    } catch (err) {
        if (err instanceof ObjError) errors.push(errorAt(err.message, err.pos, text.length));
        else throw err;
    }
    parser.pos = 0;
    const meshes: ModelMesh[] = [];
    if (errors.length === 0) {
        try {
            parser.buildMeshes(meshes);
        } catch (err) {
            if (err instanceof ObjError) errors.push(errorAt(err.message, err.pos, text.length));
            else throw err;
        }
    }
    errors.push(...parser.warnings);
    const nonEmpty = meshes.filter((mesh) => mesh.positions.length > 0); // Model::clean
    let triangles = 0;
    for (const mesh of nonEmpty) triangles += mesh.positions.length / 9;
    return {
        kind: "obj",
        parts: [{ name: "", bone: -1, offset: [0, 0, 0], meshes: nonEmpty }],
        bones: [],
        primitives: [],
        errors,
        info: [
            `${parser.coords.length - 1} vertices, ${parser.uvs.length - 1} uvs, ${parser.normals.length - 1} normals`,
            `${nonEmpty.length} materials, ${triangles} triangles`,
        ],
    };
}
