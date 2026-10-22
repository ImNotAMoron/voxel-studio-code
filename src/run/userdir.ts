// Dev user dir: <userDir>/content/<packid> links to workspace packs, so the
// engine (which only scans world:/user:/project:/res: content sources) sees
// packs being developed anywhere without copying them.
import * as fs from "node:fs";
import * as path from "node:path";

export interface LinkTarget {
    id: string;
    root: string;
}

export interface LinkReport {
    linked: string[];
    unchanged: string[];
    removed: string[];
    /** Pack ids skipped because a real folder with that name is in the way. */
    blocked: string[];
}

function isLink(p: string): boolean {
    try {
        return fs.lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

function linkTarget(p: string): string | undefined {
    try {
        return path.resolve(path.dirname(p), fs.readlinkSync(p));
    } catch {
        return undefined;
    }
}

const samePath = (a: string, b: string) =>
    process.platform === "win32"
        ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
        : path.resolve(a) === path.resolve(b);

/**
 * Links each pack into `<userDir>/content/<id>` (a junction on Windows,
 * which needs no admin rights). Our stale links are removed; real folders
 * are never touched.
 */
export function syncPackLinks(userDir: string, packs: LinkTarget[]): LinkReport {
    const contentDir = path.join(userDir, "content");
    fs.mkdirSync(contentDir, { recursive: true });
    const report: LinkReport = { linked: [], unchanged: [], removed: [], blocked: [] };
    const wanted = new Map(packs.map((p) => [p.id, p.root]));

    for (const entry of fs.readdirSync(contentDir)) {
        const full = path.join(contentDir, entry);
        if (!isLink(full)) continue;
        const target = linkTarget(full);
        const want = wanted.get(entry);
        if (!want || !target || !samePath(target, want) || !fs.existsSync(target)) {
            fs.rmSync(full, { recursive: false, force: true });
            if (!want) report.removed.push(entry);
        }
    }
    for (const [id, root] of wanted) {
        const link = path.join(contentDir, id);
        if (isLink(link)) {
            report.unchanged.push(id);
            continue;
        }
        if (fs.existsSync(link)) {
            report.blocked.push(id);
            continue;
        }
        fs.symlinkSync(root, link, process.platform === "win32" ? "junction" : "dir");
        report.linked.push(id);
    }
    return report;
}

export interface QuickWorldOptions {
    world: string;
    seed: string;
    generator: string;
    packs: string[];
    recreate: boolean;
    /** Wait (up to 15 s) for `<userDir>/export/vscode/debugger-ready` before loading content. */
    waitForDebugger?: boolean;
    /** Keep running and serve hot-reload requests from `<userDir>/export/vscode/bridge.json`. */
    bridge?: boolean;
}

/**
 * Files of the dev bridge, in `<userDir>/export/vscode/`: app scripts may only
 * write to `world:`, `export:` and `config:` (EnginePaths::isWriteable).
 */
export const BRIDGE_DIR = "export/vscode";
const BRIDGE_VPATH = "export:vscode";
export const BRIDGE_REQUESTS = "bridge.json";
export const BRIDGE_ACK = "bridge-ack.json";
export const DEBUGGER_READY = "debugger-ready";

const luaString = (s: string) => JSON.stringify(s);

function waitForDebuggerLua(): string[] {
    const ready = luaString(`${BRIDGE_VPATH}/${DEBUGGER_READY}`);
    return [
        "-- wait for VS Code to send the breakpoints (the file holds the number of",
        "-- queued debugger messages; the engine reads one per frame)",
        "do",
        "    local start = time.uptime()",
        `    while not file.exists(${ready}) and time.uptime() - start < 15 do app.tick() end`,
        `    local queued = file.exists(${ready}) and tonumber(file.read(${ready})) or 0`,
        "    for _ = 1, queued * 2 + 5 do app.tick() end",
        "end",
        "",
    ];
}

function bridgeLua(): string[] {
    const requests = luaString(`${BRIDGE_VPATH}/${BRIDGE_REQUESTS}`);
    const ack = luaString(`${BRIDGE_VPATH}/${BRIDGE_ACK}`);
    return [
        "",
        "-- dev bridge: VS Code writes hot-reload requests, this script runs them",
        "-- inside the app script coroutine (where content can be reloaded)",
        "local last = 0",
        `if file.exists(${requests}) then`,
        `    local ok, data = pcall(json.parse, file.read(${requests}))`,
        "    if ok and type(data) == \"table\" then last = data.seq or 0 end",
        "end",
        "local function run_request(request)",
        "    if request.op == \"reload_module\" then",
        "        reload_module(request.name)",
        "    elseif request.op == \"reload_content\" then",
        "        app.reconfig_packs({}, {})",
        "    else",
        "        error(\"unknown request \" .. tostring(request.op))",
        "    end",
        "end",
        "while true do",
        "    for _ = 1, 10 do app.tick() end",
        `    if file.exists(${requests}) then`,
        `        local ok, data = pcall(json.parse, file.read(${requests}))`,
        "        if ok and type(data) == \"table\" and (data.seq or 0) > last then",
        "            for _, request in ipairs(data.requests or {}) do",
        "                if request.seq > last then",
        "                    last = request.seq",
        "                    local done, err = pcall(run_request, request)",
        `                    file.write(${ack}, json.tostring({seq = request.seq, ok = done, error = (not done) and tostring(err) or nil}))`,
        "                end",
        "            end",
        "        end",
        "    end",
        "end",
    ];
}

/** App script (`--script`) that enables the packs and opens a dev world. */
export function quickWorldScript(options: QuickWorldOptions): string {
    const packs = options.packs.map(luaString).join(", ");
    return [
        "-- generated by the VoxelCore VS Code extension",
        `local packs = {${packs}}`,
        `local name = ${luaString(options.world)}`,
        "",
        ...(options.waitForDebugger ? waitForDebuggerLua() : []),
        `if ${options.recreate} and file.exists("user:worlds/" .. name) then`,
        "    app.delete_world(name)",
        "end",
        'if file.exists("user:worlds/" .. name) then',
        "    app.open_world(name)",
        "    -- enable packs added since the world was created (reopens the world)",
        "    local current = app.get_content()",
        "    local missing = {}",
        "    for _, id in ipairs(packs) do",
        "        if not table.has(current, id) then table.insert(missing, id) end",
        "    end",
        "    if #missing > 0 then app.reconfig_packs(missing, {}) end",
        "else",
        "    app.reconfig_packs(packs, {})",
        `    app.new_world(name, ${luaString(options.seed)}, ${luaString(options.generator)})`,
        "end",
        ...(options.bridge ? bridgeLua() : []),
        "",
    ].join("\n");
}
