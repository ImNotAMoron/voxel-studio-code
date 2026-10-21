import { bool, int, num, str, ref } from "./_helpers.mjs";

const GL = "src/content/loading/GeneratorLoader.cpp";
const list = (prefix) => [{ file: "world-generator.md", mode: "list", section: "Biomes", prefix }];

const weighted = (nameKey, nameMd) => ({
    type: "object",
    additionalProperties: false,
    required: [nameKey, "weight"],
    properties: {
        [nameKey]: str({ "x-md": nameMd, "x-virtual": true }),
        weight: num({ exclusiveMinimum: 0, "x-md": "Selection weight (must be positive)." }),
    },
});

export default {
    file: "biomes.schema.json",
    title: "VoxelCore generator biomes",
    description:
        "Biome definitions (`generators/<name>.files/biomes.toml`). The file is a combined object: the same " +
        "path in other packs is merged into it.",
    format: "toml",
    fileMatch: ["**/generators/*.files/biomes.toml"],
    extract: [
        { file: GL, func: "static inline Biome load_biome(", recv: ["biomeMap"], in: ["/definitions/biome"] },
        { file: GL, func: "static inline Biome load_biome(", recv: ["paramMap"], in: ["/definitions/parameter"] },
        { file: GL, func: "static BlocksLayer load_layer(", recv: ["map"], in: ["/definitions/layer"] },
        { file: GL, func: "static inline BiomeElementList load_biome_element_list(", recv: ["entry"], in: ["/definitions/plant", "/definitions/structure"] },
    ],
    schema: {
        type: "object",
        additionalProperties: ref("biome"),
        minProperties: 1,
        definitions: {
            biome: {
                type: "object",
                additionalProperties: false,
                required: ["parameters", "layers", "sea-layers"],
                "x-docs": list(""),
                properties: {
                    parameters: {
                        type: "array",
                        items: ref("parameter"),
                        "x-note": "Needs at least `biome-parameters` entries (from the generator `.toml`).",
                    },
                    layers: { type: "array", items: ref("layer") },
                    "sea-layers": { type: "array", items: ref("layer") },
                    "plant-chance": num({ minimum: 0, maximum: 1, default: 0, "x-virtual": true }),
                    plants: { type: "array", items: ref("plant"), "x-virtual": true },
                    "structure-chance": num({ minimum: 0, maximum: 1, default: 0, "x-virtual": true }),
                    structures: { type: "array", items: ref("structure") },
                },
            },
            parameter: {
                type: "object",
                additionalProperties: false,
                required: ["value", "weight"],
                properties: {
                    value: num({ description: "Central value of the parameter for this biome." }),
                    weight: num({ description: "Weight of the parameter in biome selection." }),
                },
            },
            layer: {
                type: "object",
                additionalProperties: false,
                required: ["block", "height"],
                "x-docs": list("layers"),
                properties: {
                    block: str(),
                    height: int({ minimum: -1, "x-note": "`-1` marks the single filler layer." }),
                    "below-sea-level": bool(true),
                },
            },
            plant: weighted("block", "Plant block id."),
            structure: weighted("name", "Structure name declared in `structures.toml`."),
        },
    },
};
