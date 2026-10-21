import { bool, int, str } from "./_helpers.mjs";

const AL = "src/assets/AssetsLoader.cpp";

// One preload category: list of names or {name, path, ...options}.
const category = (folder, options = {}, md = "") => ({
    type: "array",
    "x-md": `${md} Entries are names relative to \`${folder}/\` (no extension) or objects with options.`,
    items: {
        anyOf: [
            { type: "string" },
            {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: {
                    name: str({ description: "Asset name (also the default path inside the category folder)." }),
                    path: str({ description: `File path relative to the pack (default: ${folder}/<name>).` }),
                    ...options,
                },
            },
        ],
    },
});

export default {
    file: "preload.schema.json",
    title: "VoxelCore preload.json",
    description:
        "Assets to preload (`<pack>/preload.json`), read by `AssetsLoader::processPreloadConfig`. Only list " +
        "assets that aren't loaded automatically (layouts, block/item textures and models of content " +
        "units load by themselves).",
    format: "json",
    fileMatch: ["**/preload.json"],
    docs: [{ file: "assets-preload.md", mode: "headings" }],
    extract: [
        { file: AL, func: "void AssetsLoader::processPreloadConfig", recv: ["root"], in: [""] },
        {
            file: AL,
            func: "void AssetsLoader::processPreload(",
            recv: ["map"],
            any: true,
            in: [
                "/definitions/entry",
                "/properties/sounds/items/anyOf/1",
                "/properties/atlases/items/anyOf/1",
                "/properties/post-effects/items/anyOf/1",
                "/properties/models/items/anyOf/1",
                "/properties/fonts/items/anyOf/1",
            ],
        },
        { file: AL, func: "void AssetsLoader::processPreloadList", recv: ["value"], in: ["/definitions/entry"] },
    ],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            animation: category("textures", {}, "Texture animations."),
            atlases: category(
                "textures",
                {
                    type: {
                        type: "string",
                        enum: ["atlas", "separate"],
                        default: "atlas",
                        description: "atlas: pack the folder into one atlas; separate: keep the textures separate.",
                    },
                },
                "Texture atlases built from a folder of `textures/`."
            ),
            fonts: category("fonts", { size: int({ minimum: 1, description: "Font size in pixels." }) }, "Fonts."),
            models: category(
                "models",
                { squash: bool(false, { description: "Merge the model's meshes into one." }) },
                "3D models."
            ),
            "post-effects": category(
                "shaders/effects",
                {
                    advanced: bool(false, {
                        description: "Advanced post-effect (needs the advanced render pipeline, e.g. ssao).",
                    }),
                },
                "Post-processing effects."
            ),
            shaders: category("shaders", {}, "Shaders (`.glslv`/`.glslf` pairs)."),
            skeletons: category("skeletons", {}, "Skeletons (normally loaded automatically)."),
            sounds: category(
                "sounds",
                {
                    "keep-pcm": bool(false, {
                        description: "Keep decoded PCM data in memory (needed by scripts that read samples).",
                    }),
                },
                "Sounds; `name` loads `name.ogg`, `name_1.ogg`, `name_2.ogg`, ... as variants."
            ),
            textures: category("textures", {}, "Standalone textures."),
        },
        definitions: {
            // properties common to every object entry (used by the completeness check)
            entry: {
                type: "object",
                properties: {
                    name: str({ description: "Asset name (also the default path inside the category folder)." }),
                    path: str({ description: "File path relative to the pack." }),
                },
            },
        },
    },
};
