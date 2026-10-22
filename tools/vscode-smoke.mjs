// Smoke test in a real VS Code: node tools/vscode-smoke.mjs [path/to/Code(.exe)]
// Builds a temp workspace (backrooms copy + a broken pack), launches VS Code
// with this extension in development mode and runs test/vscode/suite.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const engine = path.resolve(ext, "..");
const code =
    process.argv[2] ??
    process.env.VSCODE_EXECUTABLE ??
    path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");
if (!fs.existsSync(code)) {
    console.error(`VS Code executable not found: ${code}`);
    process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-smoke-"));
const ws = path.join(tmp, "ws");
fs.cpSync(path.join(engine, "packs", "backrooms"), path.join(ws, "backrooms"), { recursive: true });
const smoke = path.join(ws, "smoke");
const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(smoke, rel)), { recursive: true });
    fs.writeFileSync(path.join(smoke, rel), text);
};
write("package.json", JSON.stringify({ id: "smoke", title: "Smoke", version: "1.0", dependencies: ["base"] }, null, 4));
write("blocks/bad.json", JSON.stringify({ texture: "missing_texture", emision: [15, 0, 0] }, null, 4));
write("blocks/good.json", JSON.stringify({ texture: "stone_tex" }, null, 4));
// block + entity previews (FEATURES.md §5.4, §5.8)
write(
    "blocks/stairs_block.json",
    JSON.stringify(
        {
            model: "custom",
            "model-name": "stairs",
            "texture-faces": ["stone_tex", "stone_tex", "stone_tex", "stone_tex", "stone_tex", "stone_tex"],
            rotation: "pipe",
            "state-based": { variants: [{ model: "block" }] },
        },
        null,
        4
    )
);
write("entities/bot.json", JSON.stringify({ "skeleton-name": "base:player", components: ["base:drop"], hitbox: [0.6, 1.8, 0.6], sensors: [["radius", 1]] }, null, 4));
fs.mkdirSync(path.join(smoke, "textures", "blocks"), { recursive: true });
fs.copyFileSync(
    path.join(engine, "res", "content", "base", "textures", "blocks", "stone.png"),
    path.join(smoke, "textures", "blocks", "stone_tex.png")
);
fs.mkdirSync(path.join(smoke, "models"), { recursive: true });
fs.copyFileSync(path.join(engine, "res", "models", "stairs.vcm"), path.join(smoke, "models", "stairs.vcm"));
fs.copyFileSync(path.join(engine, "res", "models", "block.vec3"), path.join(smoke, "models", "block.vec3"));
// debugger (FEATURES.md §4.4): a headless app script with a breakpoint on line 3
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(
    path.join(ws, "dbg_app.lua"),
    ["local function work(n)", "    local t = {a = n}", "    return n + 1", "end", "for i = 1, 100000 do", "    work(i)", "    app.tick()", "end", ""].join("\n")
);
// locale files (FEATURES.md §3.6): no translation of the smoke blocks' captions
write("texts/ru_RU.txt", "# smoke\nsomething=что-то\n");
// references + rename (FEATURES.md §3.5)
write("scripts/refs.lua", 'local good = block.index("smoke:good")\n');
// engine log → Problems (FEATURES.md §4.3): a world script error, run headless
write("scripts/world.lua", 'function on_world_open()\n    error("smoke world error")\nend\n');
fs.writeFileSync(
    path.join(ws, "smoke_app.lua"),
    [
        'app.reconfig_packs({"base", "smoke"}, {})',
        'app.new_world("smoke-log", "1", "core:default")',
        "for i = 1, 3 do app.tick() end",
        "app.quit()",
        "",
    ].join("\n")
);
const exe = path.join(engine, "build", "Debug", process.platform === "win32" ? "VoxelCore.exe" : "VoxelCore");
fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
fs.writeFileSync(
    path.join(ws, ".vscode", "settings.json"),
    JSON.stringify(
        {
            "voxelcore.resPath": path.join(engine, "res"),
            "voxelcore.configureLua": "never",
            ...(fs.existsSync(exe) ? { "voxelcore.executable": exe } : {}),
        },
        null,
        4
    )
);

const result = path.join(tmp, "result.json");
const run = spawnSync(
    code,
    [
        ws,
        `--extensionDevelopmentPath=${ext}`,
        `--extensionTestsPath=${path.join(ext, "test", "vscode", "suite.js")}`,
        `--user-data-dir=${path.join(tmp, "user-data")}`,
        `--extensions-dir=${path.join(tmp, "extensions")}`,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
    ],
    { env: { ...process.env, VC_SMOKE_RESULT: result, ELECTRON_RUN_AS_NODE: undefined }, encoding: "utf8", timeout: 300_000 }
);
if (!fs.existsSync(result)) {
    console.error("no results; VS Code output:\n" + run.stdout + run.stderr);
    process.exit(1);
}
const results = JSON.parse(fs.readFileSync(result, "utf8"));
let failed = 0;
for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (!r.ok) failed++;
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
