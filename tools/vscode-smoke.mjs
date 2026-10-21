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
fs.mkdirSync(path.join(smoke, "textures", "blocks"), { recursive: true });
fs.copyFileSync(
    path.join(engine, "res", "content", "base", "textures", "blocks", "stone.png"),
    path.join(smoke, "textures", "blocks", "stone_tex.png")
);
fs.mkdirSync(path.join(smoke, "models"), { recursive: true });
fs.copyFileSync(path.join(engine, "res", "models", "stairs.vcm"), path.join(smoke, "models", "stairs.vcm"));
fs.copyFileSync(path.join(engine, "res", "models", "block.vec3"), path.join(smoke, "models", "block.vec3"));
fs.mkdirSync(path.join(ws, ".vscode"), { recursive: true });
fs.writeFileSync(
    path.join(ws, ".vscode", "settings.json"),
    JSON.stringify({ "voxelcore.resPath": path.join(engine, "res"), "voxelcore.configureLua": "never" }, null, 4)
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
