// Pure merge logic for the sumneko.lua (LuaLS) configuration written by
// VoxelCore Tools. No `vscode` imports: unit-tested in test/lua/.

/** Extension id (`publisher.name` from package.json). */
export const EXTENSION_ID = "voxelcore.voxelcore-tools";

/**
 * Globals that exist only in some script kinds (or are injected by the
 * engine at runtime), so LuaLS must not report them as undefined.
 */
export const ENGINE_GLOBALS: readonly string[] = [
    "ARGS",
    "CUR_ENV",
    "DATA",
    "PACK_ENV",
    "PACK_ID",
    "SAVED_DATA",
    "SEED",
    "__DIR__",
    "__FILE__",
    "app",
    "document",
    "entity",
];

/** `require "name"` inside a pack resolves to `<pack>/modules/name.lua`. */
export const RUNTIME_PATH: readonly string[] = ["modules/?.lua", "modules/?/init.lua"];

/** Folders LuaLS should not index (copies of res/ in engine builds). */
export const IGNORE_DIRS_ENGINE: readonly string[] = ["build", "dist"];

export interface LuaConfigInput {
    /** Absolute path of this extension's `meta/` folder. */
    metaPath: string;
    globals?: readonly string[];
    runtimePath?: readonly string[];
    ignoreDir?: readonly string[];
}

/** Current workspace values (as returned by `inspect(...).workspaceValue`). */
export interface LuaSettingsSnapshot {
    library?: unknown;
    globals?: unknown;
    runtimeVersion?: unknown;
    runtimePath?: unknown;
    ignoreDir?: unknown;
}

export interface LuaSettingsUpdate {
    library: string[];
    globals: string[];
    runtimeVersion: string;
    runtimePath: string[];
    ignoreDir: string[];
    /** Keys whose value differs from the snapshot. */
    changed: (keyof LuaSettingsUpdate)[];
}

/** Lua settings keys (relative to the `Lua` section) for each update field. */
export const SETTING_KEYS = {
    library: "workspace.library",
    globals: "diagnostics.globals",
    runtimeVersion: "runtime.version",
    runtimePath: "runtime.path",
    ignoreDir: "workspace.ignoreDir",
} as const;

export function normalizePath(p: string): string {
    let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
    return s;
}

function samePath(a: string, b: string): boolean {
    const na = normalizePath(a);
    const nb = normalizePath(b);
    // Windows and macOS file systems are case-insensitive by default
    return na === nb || na.toLowerCase() === nb.toLowerCase();
}

/**
 * True when `entry` is the `meta` folder of another installed version of
 * this extension (e.g. `.../extensions/voxelcore.voxelcore-tools-0.1.0/meta`).
 */
export function isStaleMetaPath(entry: string, metaPath: string, extensionId = EXTENSION_ID): boolean {
    if (samePath(entry, metaPath)) return false;
    const segments = normalizePath(entry).toLowerCase().split("/");
    const id = extensionId.toLowerCase();
    const idx = segments.findIndex((s) => s === id || s.startsWith(`${id}-`));
    return idx >= 0 && segments[idx + 1] === "meta" && idx + 2 === segments.length;
}

/** Reads a string list setting; LuaLS also accepted `{path: true}` maps. */
export function toStringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
    if (value && typeof value === "object") {
        return Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v === true)
            .map(([k]) => k);
    }
    return [];
}

function union(base: readonly string[], add: readonly string[], same = (a: string, b: string) => a === b): string[] {
    const out: string[] = [];
    for (const v of [...base, ...add]) {
        if (!out.some((o) => same(o, v))) out.push(v);
    }
    return out;
}

function sameList(a: unknown, b: string[]): boolean {
    if (!Array.isArray(a) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}

/**
 * Computes the workspace `Lua.*` values: user entries are preserved, ours
 * are appended once, stale meta paths of older extension versions dropped.
 */
export function computeLuaSettings(current: LuaSettingsSnapshot, input: LuaConfigInput): LuaSettingsUpdate {
    const library = union(
        toStringList(current.library).filter((p) => !isStaleMetaPath(p, input.metaPath)),
        [input.metaPath],
        samePath
    );
    const globals = union(toStringList(current.globals), input.globals ?? ENGINE_GLOBALS);
    const runtimePath = union(toStringList(current.runtimePath), input.runtimePath ?? RUNTIME_PATH);
    const ignoreDir = union(toStringList(current.ignoreDir), input.ignoreDir ?? []);
    const runtimeVersion = "LuaJIT";
    const result: LuaSettingsUpdate = { library, globals, runtimeVersion, runtimePath, ignoreDir, changed: [] };
    if (!sameList(current.library, library)) result.changed.push("library");
    if (!sameList(current.globals, globals)) result.changed.push("globals");
    if (current.runtimeVersion !== runtimeVersion) result.changed.push("runtimeVersion");
    if (!sameList(current.runtimePath, runtimePath)) result.changed.push("runtimePath");
    if (ignoreDir.length > 0 && !sameList(current.ignoreDir, ignoreDir)) result.changed.push("ignoreDir");
    return result;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Merges our configuration into a `.luarc.json` object without clobbering
 * existing keys: lists are extended, `runtime.version` is only set when
 * absent. Both the nested (`{"runtime": {"version": ...}}`) and the dotted
 * (`{"runtime.version": ...}`) styles are supported; new keys follow the
 * style the file already uses (nested for a new file).
 */
export function mergeLuarc(existing: unknown, input: LuaConfigInput): Json {
    const out: Json = isObject(existing) ? structuredClone(existing) : {};
    const dotted = Object.keys(out).some((k) => /^(runtime|workspace|diagnostics)\./.test(k));
    if (!("$schema" in out)) {
        out.$schema = "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json";
    }

    const get = (key: string): unknown => {
        if (key in out) return out[key];
        const [section, name] = key.split(".");
        const sec = out[section];
        return isObject(sec) ? sec[name] : undefined;
    };
    const set = (key: string, value: unknown) => {
        const [section, name] = key.split(".");
        const sec = out[section];
        if (key in out || (dotted && !isObject(sec))) {
            out[key] = value;
            return;
        }
        const target: Json = isObject(sec) ? sec : {};
        target[name] = value;
        out[section] = target;
    };
    const extend = (key: string, add: readonly string[], same?: (a: string, b: string) => boolean) => {
        const current = toStringList(get(key));
        set(key, union(current, add, same));
    };

    if (get(SETTING_KEYS.runtimeVersion) === undefined) set(SETTING_KEYS.runtimeVersion, "LuaJIT");
    const library = toStringList(get(SETTING_KEYS.library)).filter((p) => !isStaleMetaPath(p, input.metaPath));
    set(SETTING_KEYS.library, union(library, [input.metaPath], samePath));
    extend(SETTING_KEYS.globals, input.globals ?? ENGINE_GLOBALS);
    extend(SETTING_KEYS.runtimePath, input.runtimePath ?? RUNTIME_PATH);
    if (input.ignoreDir && input.ignoreDir.length > 0) extend(SETTING_KEYS.ignoreDir, input.ignoreDir);
    return out;
}

/** Folders/files that mark a directory with a `package.json` as a content pack. */
export const PACK_MARKERS: readonly string[] = [
    "blocks", "items", "entities", "scripts", "modules", "layouts", "textures",
    "generators", "models", "sounds", "skeletons", "texts", "content.json",
];

/** A pack manifest has a string `id`; npm manifests have object `dependencies`. */
export function isPackManifest(json: unknown, siblings: readonly string[]): boolean {
    if (!isObject(json) || typeof json.id !== "string") return false;
    if (json.dependencies !== undefined && !Array.isArray(json.dependencies)) return false;
    return siblings.some((s) => PACK_MARKERS.includes(s));
}
