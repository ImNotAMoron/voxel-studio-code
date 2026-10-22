// File templates for the scaffolding commands. Pure functions (no vscode
// import) so they can be unit-tested.
import { PNG } from "pngjs";

export const PACK_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{1,23}$/;
export const UNIT_NAME_PATTERN = /^[a-z0-9_][a-z0-9_-]*$/;

/** ContentPack::RESERVED_NAMES (src/content/ContentPack.cpp). */
export const RESERVED_PACK_IDS = [
    "res", "abs", "local", "core", "user", "world", "none", "null", "project",
    "pack", "packid", "root",
];

export function validatePackId(id: string): string | undefined {
    if (!PACK_ID_PATTERN.test(id)) {
        return "2–24 characters: letters, digits and '_', not starting with a digit";
    }
    if (RESERVED_PACK_IDS.includes(id)) {
        return `'${id}' is a reserved name`;
    }
    return undefined;
}

export function validateUnitName(name: string): string | undefined {
    if (!UNIT_NAME_PATTERN.test(name)) {
        return "use lowercase letters, digits, '_' or '-'";
    }
    if (name.startsWith("_")) {
        return "files starting with '_' are skipped by the engine";
    }
    return undefined;
}

/** Same as util::id_to_caption: name part with '_' replaced by spaces. */
export function idToCaption(name: string): string {
    return name.replace(/^_+/, "").replace(/_/g, " ");
}

export function json(value: unknown): string {
    return JSON.stringify(value, null, 4) + "\n";
}

export interface PackInfoInput {
    id: string;
    title: string;
    creator: string;
    description: string;
    dependencies: string[];
}

export function packageJson(info: PackInfoInput): string {
    return json({
        id: info.id,
        title: info.title,
        version: "1.0",
        creator: info.creator,
        description: info.description,
        dependencies: info.dependencies,
    });
}

export type BlockKind = "basic" | "faces" | "model" | "light";

export function blockJson(name: string, kind: BlockKind, hasBase: boolean): string {
    const material = hasBase ? { material: "base:stone" } : {};
    const durability = hasBase ? { "base:durability": 1.0 } : {};
    switch (kind) {
        case "faces":
            return json({
                "texture-faces": [
                    `${name}_side`, `${name}_side`, `${name}_bottom`,
                    `${name}_top`, `${name}_side`, `${name}_side`,
                ],
                ...material,
                ...durability,
            });
        case "model":
            return json({
                model: "custom",
                "model-name": name,
                hitbox: [0, 0, 0, 1, 1, 1],
                "light-passing": true,
                ...material,
                ...durability,
            });
        case "light":
            return json({
                texture: name,
                emission: [15, 15, 15],
                shadeless: true,
                ...material,
                ...durability,
            });
        default:
            return json({ texture: name, ...material, ...durability });
    }
}

export function blockTextureNames(name: string, kind: BlockKind): string[] {
    if (kind === "faces") return [`${name}_side`, `${name}_bottom`, `${name}_top`];
    return [name];
}

export function blockModelVcm(name: string): string {
    return [
        `# model for block ${name}; textures must be in the blocks atlas`,
        `@box from (0,0,0) to (1,0.5,1) texture "blocks:${name}"`,
        "",
    ].join("\n");
}

export function blockScript(): string {
    return [
        "function on_placed(x, y, z, playerid)",
        "end",
        "",
        "function on_broken(x, y, z, playerid)",
        "end",
        "",
        "function on_interact(x, y, z, playerid)",
        "    return false",
        "end",
        "",
    ].join("\n");
}

export function itemJson(name: string): string {
    return json({ "icon-type": "sprite", icon: `items:${name}`, "stack-size": 64 });
}

export function itemScript(): string {
    return [
        "function on_use(playerid)",
        "end",
        "",
        "function on_use_on_block(x, y, z, playerid, normal)",
        "    return false",
        "end",
        "",
    ].join("\n");
}

export function entityJson(packId: string, name: string): string {
    return json({
        components: [`${packId}:${name}`],
        hitbox: [0.6, 1.8, 0.6],
        "body-type": "dynamic",
    });
}

export function componentScript(): string {
    return [
        "local tsf = entity.transform",
        "local body = entity.rigidbody",
        "",
        "function on_update(tps)",
        "end",
        "",
        "function on_save()",
        "end",
        "",
    ].join("\n");
}

export function worldScript(): string {
    return [
        "function on_world_open()",
        "end",
        "",
        "function on_world_tick()",
        "end",
        "",
    ].join("\n");
}

export interface ProjectInput {
    name: string;
    title: string;
    basePacks: string[];
    permissions: string[];
}

/** project.toml with the keys Project::deserialize reads. */
export function projectToml(info: ProjectInput): string {
    const list = (items: string[]) => (items.length ? `[\n${items.map((i) => `    ${JSON.stringify(i)},`).join("\n")}\n]` : "[]");
    return [
        `name = ${JSON.stringify(info.name)}`,
        `title = ${JSON.stringify(info.title)}`,
        `base_packs = ${list(info.basePacks)}`,
        `permissions = ${list(info.permissions)}`,
        "",
    ].join("\n");
}

/** The client script; like res/project, it shows the main menu (nothing else does). */
export function projectClientScript(): string {
    return [
        "-- Loaded on clients (not headless). on_<screen>_setup / on_<screen>_clear",
        "-- run when the menu or level screen is shown or replaced.",
        "-- Modules: require \"project:name\" loads modules/name.lua (a bare name fails here).",
        "",
        "function on_menu_setup()",
        "    menu.page = \"main\"",
        "    menu.visible = true",
        "end",
        "",
        "function on_menu_clear()",
        "end",
        "",
    ].join("\n");
}

export function projectStartScript(): string {
    return [
        "-- App script: runs at start-up as a coroutine with the `app` library.",
        "-- A --script run (the extension's Quick World and debug runs) replaces it.",
        "-- app.tick() / app.sleep(seconds) wait for frames; app.quit() exits.",
        "-- Headless, it stops at its first wait unless it is also the --script.",
        "",
    ].join("\n");
}

export function packGitignore(): string {
    return "content.json\n";
}

/** Appends `key=value` to a locale file's text unless the key exists. */
export function addLocaleEntry(text: string, key: string, value: string): string {
    const exists = text
        .split(/\r?\n/)
        .some((line) => line.split("=")[0].trim() === key);
    if (exists) return text;
    const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
    return `${text}${sep}${key}=${value}\n`;
}

/** A recognizable placeholder texture: a two-color checker seeded by name. */
export function placeholderPng(name: string, size = 16): Buffer {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const [r1, g1, b1] = hsl(hue, 0.55, 0.55);
    const [r2, g2, b2] = hsl(hue, 0.55, 0.35);
    const png = new PNG({ width: size, height: size });
    const cell = Math.max(1, size / 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dark = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 1;
            const i = (y * size + x) * 4;
            png.data[i] = dark ? r2 : r1;
            png.data[i + 1] = dark ? g2 : g1;
            png.data[i + 2] = dark ? b2 : b1;
            png.data[i + 3] = 255;
        }
    }
    return PNG.sync.write(png);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export type LayoutKind = "screen" | "inventory" | "empty";

/** layouts/<name>.xml. Every callback it names is defined by layoutScript(kind). */
export function layoutXml(kind: LayoutKind): string {
    switch (kind) {
        case "screen":
            return [
                '<container size="400,300" color="#00000080" gravity="center-center">',
                '    <panel pos="10,10" size="380,280" interval="4" padding="4">',
                '        <label id="title">Title</label>',
                '        <button onclick="on_ok()">OK</button>',
                "    </panel>",
                "</container>",
                "",
            ].join("\n");
        case "inventory":
            return [
                '<inventory color="#1F1F1FE0">',
                '    <slots-grid rows="3" cols="3" count="9" sharefunc="on_share"/>',
                "</inventory>",
                "",
            ].join("\n");
        case "empty":
            return '<container size="400,300">\n</container>\n';
    }
}

/** layouts/<name>.xml.lua: the layout's events and the callbacks layoutXml(kind) uses. */
export function layoutScript(kind: LayoutKind): string {
    switch (kind) {
        case "screen":
            return [
                "function on_open()",
                '    document.title.text = "Title"',
                "end",
                "",
                "function on_ok()",
                "end",
                "",
            ].join("\n");
        case "inventory":
            return [
                "-- a block's ui-layout: x, y, z is the block",
                "function on_open(invid, x, y, z)",
                "end",
                "",
                "function on_close(invid)",
                "end",
                "",
                "-- Shift + left click on a slot",
                "function on_share(invid, slot)",
                "end",
                "",
            ].join("\n");
        case "empty":
            return "function on_open()\nend\n";
    }
}
