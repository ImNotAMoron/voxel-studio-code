// Generates the "VoxelCore" file icon theme (icons/): coloured folder icons
// for the folders of a content pack, and icons for the pack's file types.
// An icon theme replaces the user's whole theme, so it also covers the
// common files (JSON, Lua, PNG, ...) and has plain defaults for the rest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "icons");

// Glyphs drawn on the folder body (white, centred around 8.5,10).
const stroke = (w = 1.1) => `fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const S = stroke();
const F = 'fill="#fff"';
const glyphs = {
    cube: `<path ${S} d="M8.5 6.9l3 1.6v3.2l-3 1.6-3-1.6V8.5zM5.5 8.5l3 1.6 3-1.6M8.5 10.1v3.2"/>`,
    gem: `<path ${F} d="M5.6 9.1l1.3-1.9h3.2l1.3 1.9-2.9 3.9z"/>`,
    person: `<circle ${F} cx="8.5" cy="8.4" r="1.4"/><path ${F} d="M5.8 13.2c0-1.7 1.2-2.8 2.7-2.8s2.7 1.1 2.7 2.8z"/>`,
    bone: `<path ${stroke(1.4)} d="M6.6 12l3.8-3.8"/><circle ${F} cx="6" cy="12.6" r="1"/><circle ${F} cx="11" cy="7.6" r="1"/>`,
    gear: `<circle ${S} cx="8.5" cy="10" r="1.7"/><path ${S} d="M8.5 6.9v1.1M8.5 12v1.1M5.4 10h1.1M10.5 10h1.1M6.3 7.8l.7.7M10 11.5l.7.7M6.3 12.2l.7-.7M10 8.5l.7-.7"/>`,
    mountain: `<path ${F} d="M5.3 13l2.4-4.3 1.4 2.2 1.1-1.5 1.8 3.6z"/>`,
    drop: `<path ${F} d="M8.5 6.9l2.3 3.4a2.3 2.3 0 1 1-4.6 0z"/>`,
    mesh: `<path ${S} d="M8.5 6.9l3 4.4-3 1.8-3-1.8zM8.5 6.9v6.2"/>`,
    checker: `<rect ${S} x="5.6" y="7.1" width="5.8" height="5.8"/><path ${F} d="M5.6 7.1h2.9V10H5.6zM8.5 10h2.9v2.9H8.5z"/>`,
    note: `<path ${S} d="M9.6 12V7.1l2 .9"/><circle ${F} cx="8.4" cy="12" r="1.3"/>`,
    window: `<rect ${S} x="5.4" y="7.3" width="6.2" height="5.5" rx=".6"/><path ${S} d="M5.4 9h6.2M7.6 9v3.8"/>`,
    chevrons: `<path ${S} d="M7.2 7.9l-1.9 2.1 1.9 2.1M9.8 7.9l1.9 2.1-1.9 2.1"/>`,
    braces: `<path ${S} d="M7.3 7.2c-.9 0-1.1.4-1.1 1.1v.7c0 .5-.3 1-.8 1 .5 0 .8.5.8 1v.7c0 .7.2 1.1 1.1 1.1M9.7 7.2c.9 0 1.1.4 1.1 1.1v.7c0 .5.3 1 .8 1-.5 0-.8.5-.8 1v.7c0 .7-.2 1.1-1.1 1.1"/>`,
    letter: `<path ${S} d="M5.9 12.8l2.6-5.7 2.6 5.7M6.9 10.9h3.2"/>`,
    sparkle: `<path ${F} d="M8.5 6.8l.8 2.4 2.4.8-2.4.8-.8 2.4-.8-2.4-2.4-.8 2.4-.8z"/>`,
    tee: `<path ${stroke(1.3)} d="M5.8 7.6h5.4M8.5 7.6v5.3"/>`,
    dots: `<circle ${F} cx="6.4" cy="11.6" r="1"/><circle ${F} cx="9" cy="8.4" r="1"/><circle ${F} cx="10.9" cy="11.9" r=".8"/>`,
    star: `<path ${F} d="M8.5 6.9l1 2 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2-1.6-1.5 2.2-.3z"/>`,
    sliders: `<path ${S} d="M5.4 8.5h6.2M5.4 11.5h6.2"/><circle ${F} cx="7.2" cy="8.5" r="1.1"/><circle ${F} cx="9.9" cy="11.5" r="1.1"/>`,
};

// Pack folders (doc/*/content-packs.md, ContentLoader, AssetsLoader).
const folders = [
    { names: ["blocks"], color: "#7cb342", glyph: "cube" },
    { names: ["items"], color: "#f9a825", glyph: "gem" },
    { names: ["entities"], color: "#e53935", glyph: "person" },
    { names: ["skeletons"], color: "#78909c", glyph: "bone" },
    { names: ["components"], color: "#7e57c2", glyph: "gear" },
    { names: ["generators"], color: "#00897b", glyph: "mountain" },
    { names: ["block_materials"], color: "#8d6e63", glyph: "drop" },
    { names: ["models"], color: "#1e88e5", glyph: "mesh" },
    { names: ["textures"], color: "#d81b60", glyph: "checker" },
    { names: ["sounds"], color: "#f4511e", glyph: "note" },
    { names: ["layouts"], color: "#3949ab", glyph: "window" },
    { names: ["scripts"], color: "#1565c0", glyph: "chevrons" },
    { names: ["modules"], color: "#0097a7", glyph: "braces" },
    { names: ["texts"], color: "#8e24aa", glyph: "letter" },
    { names: ["shaders"], color: "#9e9d24", glyph: "sparkle" },
    { names: ["fonts"], color: "#546e7a", glyph: "tee" },
    { names: ["particles"], color: "#ef6c00", glyph: "dots" },
    { names: ["presets"], color: "#00838f", glyph: "star" },
    { names: ["config"], color: "#607d8b", glyph: "sliders" },
];

const FOLDER_DEFAULT = "#90a4ae";

const closedFolder = (color) => `<path fill="${color}" d="M1.5 3.5c0-.6.4-1 1-1h3.3l1.5 1.5h6.2c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1z"/>`;
const openFolder = (color) =>
    `<path fill="${color}" opacity=".6" d="M1.5 3.5c0-.6.4-1 1-1h3.3l1.5 1.5h6.2c.6 0 1 .4 1 1v1.5H4.2l-2.7 6z"/>` +
    `<path fill="${color}" d="M3.9 7h11.2c.4 0 .7.4.5.8l-2.3 5.6c-.2.4-.5.6-.9.6H1.9c-.4 0-.7-.4-.5-.8l2.1-5.6c.2-.4.5-.6.9-.6z"/>`;

// File icons: a coloured glyph on 16×16, like the built-in Seti theme.
const fs1 = (color, w = 1.3) => `fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const files = {
    "file": `<path ${fs1("#90a4ae", 1.1)} d="M4 1.8h5l3 3v9.4H4zM9 1.8v3h3"/>`,
    "file-vcm": `<path ${fs1("#42a5f5")} d="M8 2.2l5 2.7v6.2L8 13.8 3 11.1V4.9zM3 4.9l5 2.7 5-2.7M8 7.6v6.2"/>`,
    "file-vca": `<path ${fs1("#ab47bc")} d="M8 2.2l5 2.7v6.2L8 13.8 3 11.1V4.9zM3 4.9l5 2.7 5-2.7M8 7.6v6.2"/><path fill="#ab47bc" d="M10.6 10.2v4.6l3.6-2.3z"/>`,
    "file-vec3": `<path ${fs1("#ff9800")} d="M8 2.2l5 2.7v6.2L8 13.8 3 11.1V4.9zM3 4.9l5 2.7 5-2.7M8 7.6v6.2"/><path ${fs1("#ff9800", .8)} d="M5.5 3.6l5 2.7M5.5 9.8v2.6M10.5 6.3v6"/>`,
    "file-obj": `<path ${fs1("#78909c")} d="M8 2.5l5.5 9H2.5zM8 2.5l1.6 9"/>`,
    "file-lua": `<circle ${fs1("#3f7fd6", 1.6)} cx="7.5" cy="8.5" r="5"/><circle fill="#3f7fd6" cx="9.3" cy="6.7" r="1.4"/><circle fill="#3f7fd6" cx="13.2" cy="2.8" r="1.2"/>`,
    "file-json": `<path ${fs1("#f9a825")} d="M5.5 2.5c-1.5 0-1.8.7-1.8 1.8v1.6c0 .9-.6 1.6-1.4 1.6.8 0 1.4.7 1.4 1.6v1.6c0 1.1.3 1.8 1.8 1.8M10.5 2.5c1.5 0 1.8.7 1.8 1.8v1.6c0 .9.6 1.6 1.4 1.6-.8 0-1.4.7-1.4 1.6v1.6c0 1.1-.3 1.8-1.8 1.8"/>`,
    "file-content": `<path ${fs1("#7cb342")} d="M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h6"/>`,
    "file-toml": `<path ${fs1("#9e9e9e")} d="M5.5 2.5H3.5v11h2M10.5 2.5h2v11h-2M6.5 6h3M6.5 9.5h3"/>`,
    "file-image": `<rect ${fs1("#26a69a", 1.2)} x="2" y="3" width="12" height="10" rx="1"/><path fill="#26a69a" d="M3.5 11.5l3-3.8 2 2.4 1.4-1.6 2.6 3z"/><circle fill="#26a69a" cx="11" cy="5.8" r="1"/>`,
    "file-audio": `<path ${fs1("#ff7043", 1.4)} d="M10 11.5V2.8l3 1.4"/><circle fill="#ff7043" cx="7.8" cy="11.6" r="2.2"/>`,
    "file-locale": `<path ${fs1("#ab47bc")} d="M2 13l3-8 3 8M3 10.6h4M9.5 4.5h4.5M11.7 3v1.5M13.2 4.5c-.4 2.6-1.8 4.6-3.6 5.6M10.4 6.6c.6 1.5 1.8 2.8 3.4 3.5"/>`,
    "file-text": `<path ${fs1("#b0bec5", 1.2)} d="M3 4h10M3 7h10M3 10h10M3 13h6"/>`,
    "file-xml": `<path ${fs1("#ff8a65")} d="M5 4.5L1.8 8 5 11.5M11 4.5L14.2 8 11 11.5M9.2 3L6.8 13"/>`,
    "file-shader": `<path fill="#c0ca33" d="M8 1.5l1.7 4.8 4.8 1.7-4.8 1.7L8 14.5l-1.7-4.8L1.5 8l4.8-1.7z"/>`,
    "file-markdown": `<path ${fs1("#42a5f5", 1.2)} d="M2.5 11.5v-7l3 3.5 3-3.5v7M12 4.5v7M10 9.5l2 2 2-2"/>`,
};

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${body}</svg>\n`;

const theme = {
    iconDefinitions: {},
    file: "file",
    folder: "folder",
    folderExpanded: "folder-open",
    rootFolder: "folder",
    rootFolderExpanded: "folder-open",
    folderNames: {},
    folderNamesExpanded: {},
    fileExtensions: {
        vcm: "file-vcm",
        vca: "file-vca",
        vec3: "file-vec3",
        obj: "file-obj",
        lua: "file-lua",
        toml: "file-toml",
        png: "file-image",
        jpg: "file-image",
        ogg: "file-audio",
        wav: "file-audio",
        xml: "file-xml",
        glslv: "file-shader",
        glslf: "file-shader",
        glsl: "file-shader",
        md: "file-markdown",
    },
    fileNames: {
        "content.json": "file-content",
    },
    // `.json` and `.txt` go by language: `texts/*.txt` is vclang (contrib/assets.json)
    languageIds: {
        json: "file-json",
        jsonc: "file-json",
        lua: "file-lua",
        vcm: "file-vcm",
        vca: "file-vca",
        vclang: "file-locale",
        plaintext: "file-text",
        xml: "file-xml",
        toml: "file-toml",
        markdown: "file-markdown",
    },
    hidesExplorerArrows: false,
};

const outputs = new Map();
const define = (id, body) => {
    outputs.set(`${id}.svg`, svg(body));
    theme.iconDefinitions[id] = { iconPath: `./${id}.svg` };
};

define("folder", closedFolder(FOLDER_DEFAULT));
define("folder-open", openFolder(FOLDER_DEFAULT));
for (const { names, color, glyph } of folders) {
    const id = `folder-${names[0]}`;
    define(id, closedFolder(color) + glyphs[glyph]);
    define(`${id}-open`, openFolder(color) + glyphs[glyph]);
    for (const name of names) {
        theme.folderNames[name] = id;
        theme.folderNamesExpanded[name] = `${id}-open`;
    }
}
for (const [id, body] of Object.entries(files)) define(id, body);
outputs.set("voxelcore-icon-theme.json", JSON.stringify(theme, null, 2) + "\n");

const check = process.argv.includes("--check");
let stale = 0;
if (!check) fs.mkdirSync(outDir, { recursive: true });
for (const [name, text] of outputs) {
    const file = path.join(outDir, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (current === text) continue;
    stale++;
    if (!check) fs.writeFileSync(file, text);
}
for (const name of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
    if (outputs.has(name)) continue;
    stale++;
    if (!check) fs.rmSync(path.join(outDir, name));
}
if (check && stale) {
    console.error(`icons/ is stale (${stale} files): run npm run icons`);
    process.exit(1);
}
console.log(check ? "icons/ is up to date" : `icons/: ${outputs.size} files (${stale} changed)`);
