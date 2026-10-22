// Lua rules: syntax, callbacks per script kind, generator sandbox, require,
// module returns and deprecated functions.

import * as fs from "node:fs";
import * as path from "node:path";
import { closest, requiredPermission } from "../../../shared/content/index";
import {
    LuaNode, assignedGlobals, globalCalls, identifierUses, namedCalls, parseLua, scriptRole, stringCalls,
    topLevelGlobalFunctions,
} from "../lua/analyze";
import {
    DEPRECATED_FALLBACK, DeprecatedEntry, GENERATOR_FORBIDDEN, KIND_LABEL, callbacksFor, kindsDefining,
    parseDeprecated,
} from "../lua/spec";
import { FileContext } from "./context";

let deprecatedCache: { res?: string; list: DeprecatedEntry[] } | undefined;

function deprecatedList(resPath?: string): DeprecatedEntry[] {
    if (deprecatedCache && deprecatedCache.res === resPath) return deprecatedCache.list;
    let list = DEPRECATED_FALLBACK;
    if (resPath) {
        try {
            const parsed = parseDeprecated(fs.readFileSync(path.join(resPath, "modules", "internal", "deprecated.lua"), "utf8"));
            if (parsed.length) list = parsed;
        } catch {
            // fallback list
        }
    }
    deprecatedCache = { res: resPath, list };
    return list;
}

let forbiddenCache: Set<string> | undefined;

/** Generator-forbidden globals, extended from meta/libraries.json when present. */
function generatorForbidden(): Set<string> {
    if (forbiddenCache) return forbiddenCache;
    const set = new Set(GENERATOR_FORBIDDEN);
    for (const candidate of [path.join(__dirname, "..", "meta"), path.join(__dirname, "..", "..", "meta"), path.join(__dirname, "..", "..", "..", "meta")]) {
        try {
            const json = JSON.parse(fs.readFileSync(path.join(candidate, "libraries.json"), "utf8")) as {
                libraries?: Record<string, { states?: string[] }>;
            };
            for (const [name, lib] of Object.entries(json.libraries ?? {})) {
                if (name.includes(":") || name.includes(".")) continue;
                if (Array.isArray(lib.states) && !lib.states.includes("generator")) set.add(name);
            }
            break;
        } catch {
            // optional
        }
    }
    forbiddenCache = set;
    return set;
}

export function lintLua(ctx: FileContext) {
    const { text, report, index, pack } = ctx;
    const parsed = parseLua(text);
    if (parsed.error) {
        const at = Math.min(parsed.error.index, Math.max(0, text.length - 1));
        report.add("VC0100", at, at + 1, `Lua syntax error: ${parsed.error.message}`);
        return;
    }
    const chunk = parsed.chunk as LuaNode;
    const role = scriptRole(index, pack, ctx.file);
    if (role.scriptName && role.users && role.users.length === 0 && !role.scriptName.includes("/")) {
        report.add("VC0063", 0, Math.min(text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length, text.length),
            `no block or item uses scripts/${role.scriptName}.lua (unit scripts are matched by 'script-name' or the unit name)`,
            { tags: ["unnecessary"] });
    }
    const uses = identifierUses(chunk);
    const usedNames = new Set(uses.map((u) => u.name));

    // callbacks
    const callbacks = callbacksFor(role.kind);
    if (callbacks) {
        const known = new Set(callbacks.map((c) => c.name));
        for (const fn of topLevelGlobalFunctions(chunk)) {
            if (known.has(fn.name) || usedNames.has(fn.name)) continue;
            const isGenerator = role.kind === "generator";
            if (!isGenerator && !fn.name.startsWith("on_")) continue;
            const suggestion = closest(fn.name, known, isGenerator ? 2 : undefined);
            if (isGenerator && !suggestion) continue;
            const others = kindsDefining(fn.name).filter((k) => k !== role.kind);
            let message = `'${fn.name}' is not an engine callback in ${KIND_LABEL[role.kind]}; this function will never be called by the engine`;
            if (suggestion) message += `. Did you mean '${suggestion}'?`;
            else if (others.length) message += ` (it is a callback of: ${others.map((k) => KIND_LABEL[k]).join(", ")})`;
            if (role.users && role.users.length) message += ` [used by ${role.users.slice(0, 3).join(", ")}${role.users.length > 3 ? ", …" : ""}]`;
            report.add("VC0101", fn.start, fn.end, message, { data: suggestion ? { suggestion } : undefined });
        }
    }

    // generator sandbox
    if (role.kind === "generator") {
        const forbidden = generatorForbidden();
        const assigned = assignedGlobals(chunk);
        for (const use of uses) {
            if (use.isLocal || !forbidden.has(use.name) || assigned.has(use.name)) continue;
            report.add("VC0102", use.start, use.end,
                `'${use.name}' is not available in generator scripts (separate Lua state with pure libraries only)`);
        }
    }

    // project scripts and the packs a project ships (<project>/content)
    const projectFile = index.projectFile(ctx.file);
    const project = projectFile?.project ?? (pack.id ? index.projectOfPack(pack) : undefined);
    if (project && !project.builtin) {
        const granted = new Set(project.permissions);
        const shadowed = assignedGlobals(chunk);
        for (const call of namedCalls(chunk)) {
            const perm = requiredPermission(call.callee, call.firstString);
            if (!perm || granted.has(perm) || shadowed.has(call.callee.split(".")[0])) continue;
            report.add("VC0503", call.start, call.end,
                `'${call.callee}' needs the project permission '${perm}', which ${path.basename(project.root)}/project.toml doesn't grant: the call throws`,
                { data: { permission: perm, projectFile: project.file } });
        }
    }

    // require
    for (const call of stringCalls(chunk)) {
        if (call.callee !== "require") continue;
        const spec = call.value;
        if (projectFile) {
            // bare names resolve through the caller's chunk name: `project:start.lua`
            // works, project_client.lua is loaded as plain `project_client.lua` (scripting.cpp)
            const colon = spec.indexOf(":");
            if (colon < 0 && projectFile.kind === "client") {
                report.add("VC0504", call.start, call.end,
                    `require '${spec}' fails in project_client.lua ("invalid path syntax (':' missing)"): its chunk name has no entry point; use 'project:${spec}'`,
                    { data: { suggestion: `project:${spec}` } });
                continue;
            }
            if (colon < 0 || spec.slice(0, colon) === "project") {
                const name = colon < 0 ? spec : spec.slice(colon + 1);
                if (!fs.existsSync(path.join(projectFile.project.root, "modules", name + ".lua"))) {
                    report.add("VC0103", call.start, call.end, `module '${spec}' not found (${path.basename(projectFile.project.root)}/modules/${name}.lua)`);
                }
                continue;
            }
        } else if (spec.startsWith("project:")) {
            continue; // the running project's modules: not known from a pack
        }
        const colon = spec.indexOf(":");
        const packId = colon >= 0 ? spec.slice(0, colon) : pack.id;
        const name = colon >= 0 ? spec.slice(colon + 1) : spec;
        if ((packId === "core" || packId === "res") && name.startsWith("internal") && pack.id !== "core") {
            report.add("VC0106", call.start, call.end, `'${spec}': core:internal modules are locked outside of the core pack`);
            continue;
        }
        if (index.resolveModule(spec, pack.id)) continue;
        const target = index.packs.get(packId === "res" ? "core" : packId);
        if (!target) {
            report.add("VC0103", call.start, call.end, `module '${spec}': pack '${packId}' is not available`, { severity: "warning" });
            continue;
        }
        let hint = "";
        if (name.endsWith(".lua")) hint = " (omit the .lua extension)";
        else if (name.startsWith("modules/")) hint = " (the modules/ folder is implied)";
        report.add("VC0103", call.start, call.end,
            `module '${spec}' not found (${target.id}/modules/${name}.lua)${hint}`,
            { data: !target.builtin ? { createModule: { pack: target.id, name } } : undefined });
    }

    // module return
    if (role.kind === "module") {
        const body = (chunk.body as LuaNode[]) ?? [];
        const last = body[body.length - 1];
        if (!last || last.type !== "ReturnStatement") {
            const end = text.trimEnd().length;
            const lineStart = text.lastIndexOf("\n", Math.max(0, end - 1)) + 1;
            report.add("VC0104", lineStart, end,
                "module does not end with a 'return' statement: require() will return nil");
        }
    }

    // deprecated
    const deprecated = new Map(deprecatedList(index.resPath).map((d) => [d.name, d]));
    const assigned = assignedGlobals(chunk);
    for (const call of globalCalls(chunk)) {
        const entry = deprecated.get(call.name);
        if (!entry || assigned.has(call.name)) continue;
        report.add("VC0105", call.start, call.end, `'${call.name}' is deprecated; use ${entry.alternative}`, { tags: ["deprecated"] });
    }
}
