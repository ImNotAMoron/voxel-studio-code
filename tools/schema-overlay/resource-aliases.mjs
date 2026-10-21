export default {
    file: "resource-aliases.schema.json",
    title: "VoxelCore resource-aliases.json",
    description:
        "Resource aliases (`<pack>/resource-aliases.json`): per resource type, an object mapping an alias " +
        "name to an existing resource (`\"base:first-person\": \"core:first-person\"`).",
    format: "json",
    fileMatch: ["**/resource-aliases.json"],
    docs: [{ file: "resources.md", mode: "headings" }],
    schema: {
        type: "object",
        additionalProperties: false,
        "x-resource-docs": {
            camera: "Cameras (`camera` resource type), e.g. `first-person`, `cinematic`. Used with the `cameras` library.",
            "post-effect-slot":
                "Post-processing effect slots (`post-effect-slot`, called *post-effect* in resources.md). Used with `gfx.posteffects`.",
        },
        "x-resource-types": {
            type: "object",
            additionalProperties: { type: "string", description: "Target resource name (pack:name)." },
        },
    },
};
