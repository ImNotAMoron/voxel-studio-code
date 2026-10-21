import { int, num, str, enumOf } from "./_helpers.mjs";

const GL = "src/content/loading/GeneratorLoader.cpp";
const interp = (md) =>
    enumOf("InterpolationType", {
        default: "linear",
        "x-md": md,
        "x-enum-docs": { file: "world-generator.md", mode: "list", section: "heightmap:resize(...)" },
    });

export default {
    file: "generator.schema.json",
    title: "VoxelCore world generator",
    description:
        "World generator config (`<pack>/generators/<name>.toml`, id `pack:name`), read by " +
        "`ContentLoader::loadGenerator`. Biomes, structures, fragments and `script.lua` live in " +
        "`generators/<name>.files/`.",
    format: "toml",
    fileMatch: ["**/generators/*.toml"],
    docs: [{ file: "world-generator.md", mode: "list", section: "Configuration file" }],
    extract: [{ file: GL, func: "void ContentLoader::loadGenerator", recv: ["map"], in: [""] }],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            caption: str(),
            "biome-parameters": int({ minimum: 0, maximum: 4, default: 0 }),
            "sea-level": int({ minimum: 0, default: 0 }),
            "biome-bpd": int({
                minimum: 1,
                default: 4,
                "x-md": "Number of blocks per point of the biome selection parameter map.",
                "x-note": "Spelled `biome-bpd` by the engine (the docs say `biomes-bpd`, which is ignored).",
            }),
            "heights-bpd": int({ minimum: 1, default: 4 }),
            "heights-interpolation": interp("Interpolation used to upscale the height map (`heights-bpd` > 1)."),
            "biomes-interpolation": interp("Interpolation used to upscale the biome parameter maps (`biome-bpd` > 1)."),
            "wide-structs-chunks-radius": int({ minimum: 0, default: 3 }),
            "heightmap-inputs": {
                type: "array",
                items: { type: "integer", minimum: 1, maximum: 4 },
                uniqueItems: true,
                "x-note": "1-based indices; each must be `<= biome-parameters`.",
            },
            "player-spawn-radius": num({ minimum: 0, default: 100 }),
            "player-min-spawn-height": int({ default: 64, "x-doc": "player-min-spawn-height" }),
            "player-max-spawn-height": int({ default: 256, "x-doc": "player-min-spawn-height" }),
        },
    },
};
