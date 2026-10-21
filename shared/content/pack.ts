// Content-pack identity rules, mirrored from the engine:
//   src/content/ContentPack.cpp (checkContentPackId, RESERVED_NAMES,
//   parse_dependency) and src/content/ContentPackVersion.cpp
//   (Version::matchesPattern).

export const RESERVED_NAMES = [
    "res", "abs", "local", "core", "user", "world", "none", "null", "project",
    "pack", "packid", "root",
];

export type DependencyLevel = "required" | "optional" | "weak";

export interface DependencyInfo {
    /** The string as written in package.json. */
    raw: string;
    level: DependencyLevel;
    id: string;
    /** `*` when not specified. */
    version: string;
    op: "=" | ">" | "<" | ">=" | "<=";
    /** Set when the engine would reject or misinterpret the entry. */
    error?: string;
}

/** Returns an error message (engine wording) or undefined when the id is valid. */
export function checkPackId(id: string): string | undefined {
    if (id.length < 2 || id.length > 24) {
        return "content-pack id length is out of range [2, 24]";
    }
    if (id[0] >= "0" && id[0] <= "9") {
        return "content-pack id must not start with a digit";
    }
    if (!/^[A-Za-z0-9_]+$/.test(id)) {
        return "illegal character in content-pack id";
    }
    if (id === "none") {
        return "content-pack id is not specified";
    }
    if (RESERVED_NAMES.includes(id)) {
        return "this content-pack id is reserved";
    }
    return undefined;
}

/** `Version::matchesPattern`: 2 or 3 dot-separated non-empty numbers. */
export function isVersionPattern(version: string): boolean {
    return /^\d+\.\d+(\.\d+)?$/.test(version);
}

export function parseVersion(version: string): [number, number, number] {
    const parts = version.split(".").filter((p) => p !== "").map((p) => parseInt(p, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareVersions(a: string, b: string): number {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (va[i] !== vb[i]) return va[i] - vb[i];
    }
    return 0;
}

/** Mirrors `parse_dependency` in ContentPack.cpp. */
export function parseDependency(raw: string): DependencyInfo {
    let name = raw;
    let level: DependencyLevel = "required";
    const result = (extra: Partial<DependencyInfo>): DependencyInfo => ({
        raw,
        level,
        id: name,
        version: "*",
        op: "=",
        ...extra,
    });
    if (name.length === 0) {
        return result({ error: "empty dependency name (the engine throws on it)" });
    }
    switch (name[0]) {
        case "!":
            name = name.slice(1);
            break;
        case "?":
            name = name.slice(1);
            level = "optional";
            break;
        case "~":
            name = name.slice(1);
            level = "weak";
            break;
    }
    let version = "*";
    let op: DependencyInfo["op"] = "=";
    const at = name.lastIndexOf("@");
    if (at >= 0) {
        version = name.slice(at + 1);
        name = name.slice(0, at);
        if (version.length >= 2) {
            const two = version.slice(0, 2);
            if (two === ">=" || two === "<=") {
                op = two;
                version = version.slice(2);
            } else if (version[0] === ">" || version[0] === "<") {
                op = version[0] as ">" | "<";
                version = version.slice(1);
            }
        } else if (version === ">" || version === "<") {
            version = "*";
        }
    }
    const info = result({ id: name, version, op });
    const idError = checkPackId(name);
    if (idError) {
        info.error = `invalid dependency id '${name}': ${idError}`;
    } else if (version !== "*" && !isVersionPattern(version)) {
        info.error =
            `version '${version}' is not a 'major.minor[.patch]' number; ` +
            "the engine then requires the dependency version to equal this string exactly";
    }
    return info;
}

/**
 * Mirrors the version check in `resolve_dependencies` (PacksManager.cpp).
 * Returns true when `actual` satisfies the dependency.
 */
export function versionSatisfies(dep: DependencyInfo, actual: string): boolean {
    if (isVersionPattern(dep.version) && isVersionPattern(actual)) {
        const c = compareVersions(actual, dep.version);
        switch (dep.op) {
            case "=": if (c === 0) return true; break;
            case ">": if (c > 0) return true; break;
            case "<": if (c < 0) return true; break;
            case ">=": if (c >= 0) return true; break;
            case "<=": if (c <= 0) return true; break;
        }
    }
    return dep.version === "*" || dep.version === actual;
}

/** Sound asset variants: `name.ogg` or `name_0.ogg` is the base (assetload::sound). */
export const SOUND_EXTENSIONS = [".ogg", ".wav"];
export const MODEL_EXTENSIONS = [".vec3", ".obj", ".xml", ".vcm"];

export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array<number>(n + 1);
    let cur = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

/** Closest candidate within a sensible edit distance, or undefined. */
export function closest(name: string, candidates: Iterable<string>, maxDistance?: number): string | undefined {
    const limit = maxDistance ?? Math.max(2, Math.floor(name.length / 3));
    let best: string | undefined;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        const d = levenshtein(name, candidate);
        if (d < bestDistance && d <= limit) {
            best = candidate;
            bestDistance = d;
        }
    }
    return best;
}
