// Minimal glm-compatible math used by the mesh builders. Matrices are
// column-major `number[16]` (element [col][row] at index col * 4 + row), and
// every operation matches the glm function named in its comment.

import type { Vec2, Vec3 } from "./types";

export type Mat4 = number[];

export function identity(): Mat4 {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** a * b */
export function mul(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + r] * b[c * 4 + k];
            }
            out[c * 4 + r] = sum;
        }
    }
    return out;
}

/** glm::translate(m, v) = m * T(v) */
export function translate(m: Mat4, v: Vec3): Mat4 {
    const t = identity();
    t[12] = v[0];
    t[13] = v[1];
    t[14] = v[2];
    return mul(m, t);
}

/** glm::scale(m, v) = m * S(v) */
export function scale(m: Mat4, v: Vec3): Mat4 {
    const s = identity();
    s[0] = v[0];
    s[5] = v[1];
    s[10] = v[2];
    return mul(m, s);
}

/** glm::rotate(m, angle, axis) = m * R(angle, axis) */
export function rotate(m: Mat4, angle: number, axis: Vec3): Mat4 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const [x, y, z] = normalize(axis);
    const t = 1 - c;
    const r: Mat4 = [
        c + t * x * x, t * x * y + s * z, t * x * z - s * y, 0,
        t * y * x - s * z, c + t * y * y, t * y * z + s * x, 0,
        t * z * x + s * y, t * z * y - s * x, c + t * z * z, 0,
        0, 0, 0, 1,
    ];
    return mul(m, r);
}

/** glm::mat4_cast(glm::quat(w, x, y, z)) — no normalisation, like glm. */
export function mat4Cast(x: number, y: number, z: number, w: number): Mat4 {
    const xx = x * x, yy = y * y, zz = z * z;
    const xz = x * z, xy = x * y, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
        1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
        2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
        2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
        0, 0, 0, 1,
    ];
}

/** m * vec4(v, w) → xyz */
export function transform(m: Mat4, v: Vec3, w: number): Vec3 {
    return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * w,
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * w,
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * w,
    ];
}

export function add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function mulScalar(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
    return [
        a[1] * b[2] - b[1] * a[2],
        a[2] * b[0] - b[2] * a[0],
        a[0] * b[1] - b[0] * a[1],
    ];
}

export function length(a: Vec3): number {
    return Math.sqrt(dot(a, a));
}

/** glm::normalize: zero vectors produce NaN, like glm. */
export function normalize(a: Vec3): Vec3 {
    return mulScalar(a, 1 / length(a));
}

export function determinant3(m: Mat4): number {
    return (
        m[0] * (m[5] * m[10] - m[9] * m[6]) -
        m[4] * (m[1] * m[10] - m[9] * m[2]) +
        m[8] * (m[1] * m[6] - m[5] * m[2])
    );
}

/**
 * `mat4_cast(rotation)` where rotation comes from `glm::decompose(matrix)`
 * (Model.cpp `extract_rotation`). Returns identity when decompose fails.
 */
export function extractRotation(m: Mat4): Mat4 {
    const eps = 1.1920929e-7; // epsilon<float>()
    const w33 = m[15];
    if (Math.abs(w33) < eps) {
        return identity();
    }
    const local = m.map((v) => v / w33);
    // determinant of the perspective-free matrix == upper 3x3 determinant
    if (Math.abs(determinant3(local)) < eps) {
        return identity();
    }
    const row: Vec3[] = [
        [local[0], local[1], local[2]],
        [local[4], local[5], local[6]],
        [local[8], local[9], local[10]],
    ];
    const scaleTo1 = (v: Vec3) => mulScalar(v, 1 / length(v));
    row[0] = scaleTo1(row[0]);
    const skewZ = dot(row[0], row[1]);
    row[1] = add(row[1], mulScalar(row[0], -skewZ));
    row[1] = scaleTo1(row[1]);
    const skewY = dot(row[0], row[2]);
    row[2] = add(row[2], mulScalar(row[0], -skewY));
    const skewX = dot(row[1], row[2]);
    row[2] = add(row[2], mulScalar(row[1], -skewX));
    row[2] = scaleTo1(row[2]);
    if (dot(row[0], cross(row[1], row[2])) < 0) {
        for (let i = 0; i < 3; i++) {
            row[i] = mulScalar(row[i], -1);
        }
    }
    const q = [0, 0, 0, 0]; // x, y, z, w
    const trace = row[0][0] + row[1][1] + row[2][2];
    if (trace > 0) {
        let root = Math.sqrt(trace + 1);
        q[3] = 0.5 * root;
        root = 0.5 / root;
        q[0] = root * (row[1][2] - row[2][1]);
        q[1] = root * (row[2][0] - row[0][2]);
        q[2] = root * (row[0][1] - row[1][0]);
    } else {
        const next = [1, 2, 0];
        let i = 0;
        if (row[1][1] > row[0][0]) i = 1;
        if (row[2][2] > row[i][i]) i = 2;
        const j = next[i];
        const k = next[j];
        let root = Math.sqrt(row[i][i] - row[j][j] - row[k][k] + 1);
        q[i] = 0.5 * root;
        root = 0.5 / root;
        q[j] = root * (row[i][j] + row[j][i]);
        q[k] = root * (row[i][k] + row[k][i]);
        q[3] = root * (row[j][k] - row[k][j]);
    }
    return mat4Cast(q[0], q[1], q[2], q[3]);
}

export function radians(deg: number): number {
    return (deg * Math.PI) / 180;
}

export type { Vec2, Vec3 };
