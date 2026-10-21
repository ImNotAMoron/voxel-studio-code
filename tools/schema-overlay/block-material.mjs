import { num, str } from "./_helpers.mjs";

const md = (s) => ({ "x-md": s });

export default {
    file: "block-material.schema.json",
    title: "VoxelCore block material",
    description:
        "Block material (`<pack>/block_materials/<name>.json`, id `pack:name`), read by " +
        "`BlockMaterial::deserialize` (`src/voxels/Block.cpp`). Referenced from a block's `material`.",
    format: "json",
    fileMatch: ["**/block_materials/*.json"],
    extract: [{ file: "src/voxels/Block.cpp", func: "void BlockMaterial::deserialize", recv: ["src"], in: [""] }],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            name: str(md("Overrides the material name. Normally omitted: the id is `pack:<file name>`.")),
            "steps-sound": str(md("Footsteps sound name (e.g. `steps/stone`), loaded with all its variants.")),
            "place-sound": str(md("Sound played when a block of this material is placed.")),
            "break-sound": str(md("Sound played when a block of this material is broken.")),
            "hit-sound": str(md("Sound played while hitting the block. Default: `steps-sound`.")),
            "sound-absorption": num({
                minimum: 0,
                maximum: 1,
                default: 0.5,
                ...md("How much the material absorbs sound (used by audio occlusion), 0.0 to 1.0."),
            }),
        },
    },
};
