import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const ICONS = path.join(ROOT, "icons");

test("icons/ matches tools/gen-icons.mjs", () => {
    execFileSync(process.execPath, [path.join(ROOT, "tools", "gen-icons.mjs"), "--check"], { stdio: "pipe" });
});

test("icon theme references only defined icons with existing SVGs", () => {
    const theme = JSON.parse(fs.readFileSync(path.join(ICONS, "voxelcore-icon-theme.json"), "utf8"));
    const defs: Record<string, { iconPath: string }> = theme.iconDefinitions;
    for (const def of Object.values(defs)) {
        const svg = fs.readFileSync(path.join(ICONS, def.iconPath), "utf8");
        assert.match(svg, /^<svg [^>]*viewBox="0 0 16 16"/);
        // a repeated attribute makes the whole SVG invalid (the icon disappears)
        for (const tag of svg.match(/<[a-z]+ [^>]*>/g) ?? []) {
            const names = [...tag.matchAll(/ ([a-z-]+)=/g)].map((m) => m[1]);
            assert.equal(new Set(names).size, names.length, `${def.iconPath}: ${tag}`);
        }
    }
    const used = [
        theme.file, theme.folder, theme.folderExpanded, theme.rootFolder, theme.rootFolderExpanded,
        ...["folderNames", "folderNamesExpanded", "fileExtensions", "fileNames", "languageIds"].flatMap((k) => Object.values(theme[k] as Record<string, string>)),
    ];
    for (const id of used) assert.ok(defs[id], `undefined icon ${id}`);
    // every folder the engine reads from a pack has an icon
    for (const name of ["blocks", "items", "entities", "skeletons", "generators", "block_materials", "models", "textures", "sounds", "layouts", "scripts", "modules", "texts", "shaders", "fonts", "config"]) {
        assert.ok(theme.folderNames[name] && theme.folderNamesExpanded[name], name);
    }
});

test("the icon theme is contributed and packaged", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const theme = pkg.contributes.iconThemes.find((t: { id: string }) => t.id === "voxelcore");
    assert.ok(fs.existsSync(path.join(ROOT, theme.path)));
    assert.match(fs.readFileSync(path.join(ROOT, ".vscodeignore"), "utf8"), /^!icons\/\*\*$/m);
});
