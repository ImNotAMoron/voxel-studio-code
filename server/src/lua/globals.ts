// Global names a Lua callback can see without defining them: Lua/LuaJIT
// builtins, the engine libraries (meta/libraries.json), globals the engine's
// own scripts assign (res/scripts, res/modules: `menu`, `Document`, ...),
// and the names environments add (scripting.cpp create_*_environment).

import * as fs from "node:fs";
import * as path from "node:path";
import { assignedGlobals, parseLua } from "./analyze";

const LUA_BUILTINS = [
    "_G", "_VERSION", "assert", "collectgarbage", "dofile", "error", "gcinfo", "getfenv", "getmetatable", "ipairs", "load",
    "loadfile", "loadstring", "module", "newproxy", "next", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset",
    "require", "select", "setfenv", "setmetatable", "tonumber", "tostring", "type", "unpack", "xpcall",
    "bit", "coroutine", "debug", "ffi", "io", "jit", "math", "os", "package", "string", "table",
    "self", // `function(self, ...)` callers aside, never worth a warning
];

/** Set by create_pack_environment / create_doc_environment and friends. */
const ENV_NAMES = ["PACK_ENV", "PACK_ID", "DOC_ENV", "DOC_NAME", "document", "SAVED_DATA", "SCRIPT_ENV"];

let cache: { res?: string; names: Set<string> } | undefined;

function metaLibraries(): string[] {
    for (const candidate of [path.join(__dirname, "..", "meta"), path.join(__dirname, "..", "..", "meta"), path.join(__dirname, "..", "..", "..", "meta")]) {
        try {
            const json = JSON.parse(fs.readFileSync(path.join(candidate, "libraries.json"), "utf8")) as {
                libraries?: Record<string, { functions?: string[] }>;
            };
            const libs = json.libraries ?? {};
            return [
                ...Object.keys(libs).filter((n) => !n.includes(":")).map((n) => n.split(".")[0]),
                ...(libs._G?.functions ?? []),
            ];
        } catch {
            // optional
        }
    }
    return [];
}

function scriptGlobals(dir: string, out: Set<string>) {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) scriptGlobals(p, out);
        else if (e.name.endsWith(".lua")) {
            const { chunk } = parseLua(fs.readFileSync(p, "utf8"));
            if (chunk) for (const name of assignedGlobals(chunk)) out.add(name);
        }
    }
}

/** Names that are defined everywhere (cached per engine res/ folder). */
export function engineGlobals(resPath: string | undefined): Set<string> {
    if (cache && cache.res === resPath) return cache.names;
    const names = new Set([...LUA_BUILTINS, ...ENV_NAMES, ...metaLibraries()]);
    if (resPath) {
        scriptGlobals(path.join(resPath, "scripts"), names);
        scriptGlobals(path.join(resPath, "modules"), names);
    }
    cache = { res: resPath, names };
    return names;
}
