import { strArray } from "./_helpers.mjs";

// "x-resource-types": the generator expands this into one property per
// ResourceTypeMeta entry (src/content/content_fwd.hpp).
export default {
    file: "resources.schema.json",
    title: "VoxelCore resources.json",
    description:
        "Resource requests (`<pack>/resources.json`): lists of names per resource type. Names get the pack " +
        "prefix (`cinematic` in pack `base` becomes `base:cinematic`). Unknown types are ignored with a warning.",
    format: "json",
    fileMatch: ["**/resources.json"],
    docs: [{ file: "resources.md", mode: "headings" }],
    schema: {
        type: "object",
        additionalProperties: false,
        "x-resource-docs": {
            camera: "Cameras (`camera` resource type), e.g. `first-person`, `cinematic`. Used with the `cameras` library.",
            "post-effect-slot":
                "Post-processing effect slots (`post-effect-slot`, called *post-effect* in resources.md). Used with `gfx.posteffects`.",
        },
        "x-resource-types": strArray({ uniqueItems: true }),
    },
};
