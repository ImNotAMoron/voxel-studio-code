// Known property names per definition kind: built-in lists taken from the
// engine loaders, merged with the generated JSON Schemas (schemas/*.schema.json)
// when they are present.

import * as fs from "node:fs";
import * as path from "node:path";

export type DefKind = "block" | "item" | "entity" | "material" | "skeleton" | "package" | "preload";

/** res/scripts/post_content.lua `names` — properties surviving the cleanup. */
export const POST_CONTENT_NAMES = [
    "parent", "caption", "texture", "texture-faces", "model", "model-name",
    "model-primitives", "material", "rotation", "hitboxes", "hitbox", "emission",
    "size", "obstacle", "replaceable", "light-passing", "sky-light-passing",
    "shadeless", "ambient-occlusion", "breakable", "selectable", "grounded",
    "hidden", "draw-group", "picking-item", "surface-replacement", "script-name",
    "ui-layout", "inventory-size", "tick-interval", "overlay-texture",
    "translucent", "fields", "particles", "icon-type", "icon", "placing-block",
    "stack-size", "name", "script-file", "culling", "solid",
];

/** Keys read by src/content/loading/BlockLoader.cpp (+ process_tags). */
const BLOCK_KEYS = [
    ...POST_CONTENT_NAMES, "state-based", "grounding-behaviour", "tags",
];

/** src/content/loading/ItemLoader.cpp */
const ITEM_KEYS = [
    ...POST_CONTENT_NAMES, "description", "uses", "uses-display", "tags",
];

/** src/content/loading/EntityLoader.cpp */
const ENTITY_KEYS = [
    "parent", "components", "hitbox", "sensors", "save", "save-skeleton-pose",
    "save-skeleton-textures", "save-body-velocity", "save-body-settings",
    "body-type", "skeleton-name", "material", "blocking", "selectable", "solid",
    "mass", "elasticity", "step-height", "lighting-mode",
];

/** BlockMaterial::deserialize (src/voxels/Block.cpp) */
const MATERIAL_KEYS = ["name", "steps-sound", "place-sound", "break-sound", "hit-sound", "sound-absorption"];

const SKELETON_KEYS = ["root", "name", "model", "offset", "nodes"];

/** ContentPack::read */
const PACKAGE_KEYS = ["id", "title", "version", "creator", "creators", "description", "source", "dependencies"];

/** AssetsLoader::processPreloadConfig */
const PRELOAD_KEYS = ["animation", "atlases", "fonts", "models", "post-effects", "shaders", "skeletons", "sounds", "textures"];

const BUILTIN: Record<DefKind, string[]> = {
    block: BLOCK_KEYS,
    item: ITEM_KEYS,
    entity: ENTITY_KEYS,
    material: MATERIAL_KEYS,
    skeleton: SKELETON_KEYS,
    package: PACKAGE_KEYS,
    preload: PRELOAD_KEYS,
};

/** Variant properties (`state-based.variants[]`, BlockLoader.cpp load_variant). */
export const VARIANT_KEYS = ["texture", "texture-faces", "model", "model-name", "model-primitives", "culling", "draw-group"];

interface JsonSchema {
    properties?: Record<string, unknown>;
    allOf?: JsonSchema[];
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    $ref?: string;
    definitions?: Record<string, JsonSchema>;
    $defs?: Record<string, JsonSchema>;
    [key: string]: unknown;
}

function collectProperties(schema: JsonSchema, root: JsonSchema, out: Set<string>, depth = 0) {
    if (!schema || typeof schema !== "object" || depth > 8) return;
    if (schema.properties) for (const key of Object.keys(schema.properties)) out.add(key);
    for (const list of [schema.allOf, schema.anyOf, schema.oneOf]) {
        if (Array.isArray(list)) for (const sub of list) collectProperties(sub, root, out, depth + 1);
    }
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
        let target: unknown = root;
        for (const part of schema.$ref.slice(2).split("/")) {
            target = target && typeof target === "object" ? (target as Record<string, unknown>)[part] : undefined;
        }
        if (target) collectProperties(target as JsonSchema, root, out, depth + 1);
    }
}

function kindOfSchemaFile(name: string): DefKind | undefined {
    const n = name.toLowerCase();
    if (n.includes("material")) return "material";
    if (n.includes("block")) return "block";
    if (n.includes("item")) return "item";
    if (n.includes("entit")) return "entity";
    if (n.includes("skeleton")) return "skeleton";
    if (n.includes("package")) return "package";
    if (n.includes("preload")) return "preload";
    return undefined;
}

export class SchemaStore {
    private known = new Map<DefKind, Set<string>>();
    schemaDir?: string;

    constructor(schemaDir?: string) {
        for (const [kind, keys] of Object.entries(BUILTIN) as [DefKind, string[]][]) {
            this.known.set(kind, new Set(keys));
        }
        this.schemaDir = schemaDir ?? findSchemaDir();
        if (this.schemaDir) this.loadDir(this.schemaDir);
    }

    private loadDir(dir: string) {
        let files: string[];
        try {
            files = fs.readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
        } catch {
            return;
        }
        for (const file of files) {
            const kind = kindOfSchemaFile(file);
            if (!kind) continue;
            try {
                const schema = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as JsonSchema;
                const props = new Set<string>();
                collectProperties(schema, schema, props);
                const set = this.known.get(kind)!;
                for (const p of props) set.add(p);
            } catch {
                // tolerate broken / missing schemas
            }
        }
    }

    knownKeys(kind: DefKind): Set<string> {
        return this.known.get(kind) ?? new Set();
    }
}

function findSchemaDir(): string | undefined {
    const candidates = [
        path.join(__dirname, "..", "schemas"),
        path.join(__dirname, "..", "..", "schemas"),
        path.join(__dirname, "..", "..", "..", "schemas"),
    ];
    for (const dir of candidates) {
        try {
            if (fs.statSync(dir).isDirectory()) return dir;
        } catch {
            // next
        }
    }
    return undefined;
}
