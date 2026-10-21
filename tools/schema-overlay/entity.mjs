import { bool, num, str, enumOf, numArray } from "./_helpers.mjs";

const EL = "src/content/loading/EntityLoader.cpp";

export default {
    file: "entity.schema.json",
    title: "VoxelCore entity definition",
    description:
        "Entity definition (`<pack>/entities/**/*.json`), loaded by `EntityLoader.cpp`. Entities have no " +
        "`tags`, user properties or `@append` methods.",
    format: "json",
    fileMatch: ["**/entities/**/*.json"],
    docs: [{ file: "entity-properties.md", mode: "headings" }],
    extract: [{ file: EL, func: "ContentUnitLoader<EntityDef>::loadUnit", recv: ["root", "elem"], in: ["", "/definitions/componentObject"], any: true }],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            parent: str({
                "x-md":
                    "Full id of an entity to inherit from (`pack:name`). The parent definition is copied first, " +
                    "then this file's properties are applied on top.",
            }),
            components: {
                type: "array",
                items: {
                    anyOf: [
                        { type: "string", description: "Component id (`pack:name`, script in `scripts/components/`)." },
                        { $ref: "#/definitions/componentObject" },
                    ],
                },
                defaultSnippets: [{ label: "component", body: ["${1:pack}:${2:component}"] }],
            },
            hitbox: numArray(3, {
                default: [0.25, 0.25, 0.25],
                defaultSnippets: [{ label: "[w, h, d]", body: ["${1:0.6}", "${2:1.8}", "${3:0.6}"] }],
            }),
            "body-type": enumOf("BodyType", { default: "dynamic" }),
            blocking: bool(true),
            selectable: bool(true),
            sensors: {
                type: "array",
                items: {
                    anyOf: [
                        {
                            type: "array",
                            items: [{ const: "radius" }, num({ minimum: 0 })],
                            minItems: 2,
                            maxItems: 2,
                            description: '["radius", r]: a sphere around the hitbox center.',
                        },
                        {
                            type: "array",
                            items: [{ const: "aabb" }, num(), num(), num(), num(), num(), num()],
                            minItems: 7,
                            maxItems: 7,
                            description: '["aabb", x1, y1, z1, x2, y2, z2]: an axis-aligned box (does not rotate).',
                        },
                    ],
                },
                defaultSnippets: [
                    { label: "radius sensor", body: [["radius", "${1:1.0}"]] },
                    { label: "aabb sensor", body: [["aabb", -0.2, -0.2, -0.2, 0.2, 0.2, 0.2]] },
                ],
            },
            solid: bool(false),
            mass: num({ minimum: 0, default: 1.0 }),
            elasticity: num({ minimum: 0, default: 0.0 }),
            "step-height": num({ minimum: 0, default: 0.5 }),
            material: str(),
            "skeleton-name": str({ "x-note": "Default: the entity id." }),
            "lighting-mode": enumOf("ModelLightingMode", { default: "solid" }),
            save: bool(true, { "x-doc": { file: "entity-properties.md", mode: "table", section: "Saving/Loading", key: "save" } }),
            "save-skeleton-pose": bool(false, { "x-doc": { file: "entity-properties.md", mode: "table", section: "Saving/Loading" } }),
            "save-skeleton-textures": bool(false, { "x-doc": { file: "entity-properties.md", mode: "table", section: "Saving/Loading" } }),
            "save-body-velocity": bool(true, { "x-doc": { file: "entity-properties.md", mode: "table", section: "Saving/Loading" } }),
            "save-body-settings": bool(true, { "x-doc": { file: "entity-properties.md", mode: "table", section: "Saving/Loading" } }),
        },
        definitions: {
            componentObject: {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: {
                    name: str({ description: "Component id (`pack:name`)." }),
                    args: { description: "Value passed to the component as `ARGS` (on creation and on load)." },
                },
            },
        },
    },
};
