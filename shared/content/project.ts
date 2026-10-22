// VoxelCore projects: the "app" running on the engine (`--project <dir>`).
// Pure, no `vscode` import.
//
// Engine references:
// - project.toml: src/devtools/Project.cpp (Project::deserialize), loaded by
//   Engine::loadProject from `project:project.toml`
// - permissions: src/devtools/Project.hpp (Permissions), checked in
//   Engine.cpp (network, record-audio), EnginePaths::setupProject
//   (write-to-user), libapp.cpp (debugging, sub-instances), libnetwork.cpp
// - scripts: src/devtools/AppScriptsControl.cpp (`project:start.lua` unless
//   --script is given; `project:project_client.lua` on clients only)
// - content: ContentControl.cpp default_content_sources (`project:content`)
// - default project: Engine.cpp (`<userdir>/project`, then `res/project`,
//   then `res`)

export const PROJECT_FILE = "project.toml";
export const START_SCRIPT = "start.lua";
export const CLIENT_SCRIPT = "project_client.lua";

export interface PermissionInfo {
    name: string;
    doc: string;
}

export const PERMISSIONS: PermissionInfo[] = [
    { name: "debugging", doc: "`app.start_debug_instance` (start an engine instance with a debugging server)" },
    { name: "network", doc: "the `network` library (everything except `network.is_available`)" },
    { name: "record-audio", doc: "audio input (`audio.input`, microphone recording)" },
    { name: "write-to-user", doc: "writing to `user:` (the user folder) with `file.write`, `file.remove`, …" },
    { name: "sub-instances", doc: "`app.start_background_instance` (run another engine instance)" },
];

export const PERMISSION_NAMES = new Set(PERMISSIONS.map((p) => p.name));

export interface ProjectInfo {
    /** Absolute folder path. */
    root: string;
    /** project.toml path. */
    file: string;
    name?: string;
    title?: string;
    basePacks: string[];
    permissions: string[];
    /** `<root>/content` (a content source). */
    contentDir: string;
    startScript?: string;
    clientScript?: string;
    /** The engine's own default project (`res/project`). */
    builtin: boolean;
}

// libfile.cpp functions that go through is_writeable (get_writeable_path):
// `user:` is writeable only with write-to-user (EnginePaths::setupProject).
const USER_WRITES = new Set(["file.write", "file.write_bytes", "file.remove", "file.remove_tree"]);

/**
 * The permission a call needs, when the engine throws without it:
 * libnetwork.cpp `wrap<>` ("network subsystem is not available in the
 * project"; only `is_available` is exempt), libapp.cpp
 * `l_start_debug_instance` / `l_start_background_instance`, libfile.cpp
 * ("access denied").
 */
export function requiredPermission(callee: string, firstString?: string): string | undefined {
    if (callee.startsWith("network.") && callee !== "network.is_available") return "network";
    if (callee === "app.start_debug_instance") return "debugging";
    if (callee === "app.start_background_instance") return "sub-instances";
    if (USER_WRITES.has(callee) && firstString?.startsWith("user:")) return "write-to-user";
    return undefined;
}

/**
 * Text edit adding `perm` to the top-level `permissions` array of a
 * project.toml: [start, end, newText] in `text` offsets.
 */
export function grantPermissionEdit(text: string, perm: string): [number, number, string] {
    const quoted = JSON.stringify(perm);
    const m = /^permissions\s*=\s*\[/m.exec(text);
    if (m) {
        const open = m.index + m[0].length;
        const close = text.indexOf("]", open);
        if (close >= 0) {
            const inner = text.slice(open, close);
            if (!inner.trim()) return [open, close, quoted];
            // replace the trailing `, ` / newline before `]`, keeping a multi-line array's layout
            const at = open + inner.replace(/[\s,]*$/, "").length;
            const indent = /\n([ \t]*)\S/.exec(inner)?.[1];
            if (indent === undefined) return [at, close, `, ${quoted}`];
            return [at, close, `,\n${indent}${quoted}${inner.slice(at - open).replace(/,/g, "")}`];
        }
    }
    // before the first [table] header: top-level keys must come first
    const header = /^\s*\[/m.exec(text);
    const at = header ? header.index : text.length;
    const sep = at > 0 && text[at - 1] !== "\n" ? "\n" : "";
    return [at, at, `${sep}permissions = [${quoted}]\n`];
}

/** Screens whose names make the project client script callbacks (`Screen::getName`). */
export const PROJECT_SCREENS = ["menu", "level"];

/** Reads the fields the engine reads; anything else is ignored by Project::deserialize. */
export function projectFields(toml: Record<string, unknown> | undefined): Pick<ProjectInfo, "name" | "title" | "basePacks" | "permissions"> {
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
        name: typeof toml?.name === "string" ? toml.name : undefined,
        title: typeof toml?.title === "string" ? toml.title : undefined,
        basePacks: strings(toml?.base_packs),
        permissions: strings(toml?.permissions),
    };
}
