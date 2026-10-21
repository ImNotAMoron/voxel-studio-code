import { int, ref } from "./_helpers.mjs";

export default {
    file: "structures.schema.json",
    title: "VoxelCore generator structures",
    description:
        "Structure definitions (`generators/<name>.files/structures.toml`): each key is a structure name that " +
        "must match a fragment `fragments/<name>.vox`. Combined object (merged across packs).",
    format: "toml",
    fileMatch: ["**/generators/*.files/structures.toml"],
    extract: [
        { file: "src/content/loading/GeneratorLoader.cpp", func: "static VoxelStructureMeta load_structure_meta", recv: ["config"], in: ["/definitions/structure"] },
    ],
    schema: {
        type: "object",
        additionalProperties: ref("structure"),
        definitions: {
            structure: {
                type: "object",
                additionalProperties: false,
                "x-docs": [{ file: "world-generator.md", mode: "list", section: "Structures" }],
                properties: {
                    lowering: int({ default: 0 }),
                },
            },
        },
    },
};
