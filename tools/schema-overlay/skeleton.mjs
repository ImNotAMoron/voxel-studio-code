import { str, vec3, ref } from "./_helpers.mjs";

export default {
    file: "skeleton.schema.json",
    title: "VoxelCore skeleton",
    description:
        "Entity skeleton (`<pack>/skeletons/<name>.json`, id `pack:name`), parsed by " +
        "`SkeletonConfig::parse` (`src/animation/rigging.cpp`).",
    format: "json",
    fileMatch: ["**/skeletons/*.json"],
    docs: [{ file: "rigging.md", mode: "list", section: "Skeletons" }],
    extract: [
        { file: "src/animation/rigging.cpp", func: "SkeletonConfig::parse(", recv: ["root"], in: [""] },
        { file: "src/animation/rigging.cpp", func: "read_node(\n", recv: ["root"], in: ["/definitions/node"] },
    ],
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["root"],
        properties: {
            root: ref("node"),
        },
        definitions: {
            node: {
                type: "object",
                additionalProperties: false,
                "x-docs": [{ file: "rigging.md", mode: "list", section: "Skeletons" }],
                properties: {
                    name: str(),
                    model: str({ "x-note": "Model name (`models/` folder of a pack; vcm, obj or vec3)." }),
                    offset: vec3([0, 0, 0]),
                    nodes: { type: "array", items: ref("node") },
                },
            },
        },
    },
};
