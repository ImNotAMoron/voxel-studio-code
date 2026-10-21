import { bool, int, num, str, strArray, enumOf, ref, numArray } from "./_helpers.mjs";

const BL = "src/content/loading/BlockLoader.cpp";

// Properties that may vary per state-based variant (BlockLoader.cpp::load_variant).
const variantProps = () => ({
    texture: str(),
    "texture-faces": ref("textureFaces"),
    model: enumOf("BlockModelType", { default: "block" }),
    "model-name": str(),
    "model-primitives": {
        ...ref("modelPrimitives"),
        "x-doc": { file: "block-models.md", mode: "headings", section: "Block Models (deprecated)" },
    },
    culling: enumOf("CullingMode", { default: "default" }),
    "draw-group": int({ minimum: 0, maximum: 255, default: 0 }),
});

const textureExclusion = {
    not: { required: ["texture", "texture-faces"] },
    "x-md":
        "`texture` and `texture-faces` are mutually exclusive: when both are present the engine " +
        "silently uses `texture`.",
};

export default {
    file: "block.schema.json",
    title: "VoxelCore block definition",
    description:
        "Block definition (`<pack>/blocks/**/*.json`), loaded by `BlockLoader.cpp`. Unknown keys are " +
        "silently dropped by the engine, so they are reported here.",
    format: "json",
    fileMatch: ["**/blocks/**/*.json"],
    docs: [{ file: "block-properties.md", mode: "headings" }],
    luaProperties: "block",
    extract: [
        { file: BL, func: "ContentUnitLoader<Block>::loadUnit", recv: ["root"], in: [""] },
        { file: BL, func: "static void load_variant", recv: ["root"], in: ["", "/definitions/variant"] },
        { file: BL, func: "ContentUnitLoader<Block>::loadUnit", recv: ["stateBased"], in: ["/properties/state-based"] },
        { file: "src/data/StructLayout.cpp", func: "void StructLayout::deserialize", recv: ["fieldmap"], in: ["/definitions/field"] },
        { file: "src/content/loading/ContentLoadingCommons.hpp", recv: ["root"], in: [""] },
        { file: "src/graphics/render/ModelsGenerator.cpp", func: "ModelsGenerator::loadCustomBlockModel", recv: ["primitives"], in: ["/definitions/modelPrimitives"] },
    ],
    schema: {
        type: "object",
        "x-append": true,
        "x-user-props": true,
        allOf: [
            textureExclusion,
            {
                not: { required: ["hitbox", "hitboxes"] },
                "x-md": "`hitbox` and `hitboxes` are mutually exclusive: when both are present the engine uses `hitboxes`.",
            },
            {
                // a custom model without a parent needs geometry
                if: {
                    properties: { model: { const: "custom" } },
                    required: ["model"],
                    not: { required: ["parent"] },
                },
                then: { anyOf: [{ required: ["model-name"] }, { required: ["model-primitives"] }] },
                "x-md": "`\"model\": \"custom\"` requires `model-name` (or the deprecated `model-primitives`).",
            },
        ],
        properties: {
            parent: str({
                "x-md":
                    "Full id of a block to inherit from (`pack:name`). The parent definition is copied first, " +
                    "then this file's properties are applied on top. The parent is loaded first even if it " +
                    "is defined later in the pack.",
            }),
            caption: str({ "x-md": "Display name of the block (and its generated item). Default: generated from the id." }),
            ...variantProps(),
            texture: str({ "x-note": "Mutually exclusive with `texture-faces`." }),
            translucent: bool(false),
            solid: bool(false),
            rotation: {
                type: "string",
                default: "none",
                "x-enum-regex": { file: "src/voxels/Block.hpp", regex: '_NAME = "(\\w+)"', extra: ["none"] },
            },
            particles: { $ref: "particles.schema.json" },
            material: str({ "x-note": "Default: `block-material` from `config/defaults.toml` (base: `base:stone`)." }),
            "state-based": {
                type: "object",
                additionalProperties: false,
                "x-doc": { file: "block-properties.md", mode: "headings", section: "Variants" },
                properties: {
                    offset: int({ minimum: 0, maximum: 7, default: 0, "x-md": "Bit offset in the block's user bits where the variant index starts." }),
                    bits: int({
                        minimum: 1,
                        maximum: 8,
                        default: 4,
                        "x-md":
                            "Number of bits encoding the variant index (`offset + bits` must not exceed 8). " +
                            "At most 16 variants exist, so more than 4 bits is not useful.",
                    }),
                    variants: {
                        type: "array",
                        maxItems: 15,
                        items: ref("variant"),
                        "x-md":
                            "Variants 1..N (variant 0 is the block's root definition). Each variant starts as a copy " +
                            "of the root and may override `model`, `model-name`, `texture`, `texture-faces`, " +
                            "`model-primitives`, `culling` and `draw-group`. Up to 15 entries (16 variants in total).",
                    },
                },
            },
            emission: {
                type: "array",
                items: { type: "integer", minimum: 0, maximum: 15 },
                minItems: 3,
                maxItems: 3,
                default: [0, 0, 0],
                defaultSnippets: [{ label: "[r, g, b]", body: ["${1:15}", "${2:15}", "${3:15}"] }],
            },
            "light-passing": bool(false),
            "sky-light-passing": bool(false),
            shadeless: bool(false),
            "ambient-occlusion": bool(true),
            obstacle: bool(true),
            hitbox: ref("hitbox"),
            hitboxes: {
                type: "array",
                items: ref("hitbox"),
                "x-doc": "hitbox",
                "x-md": "List of hitboxes (`[x, y, z, width, height, depth]` each) for composite shapes.",
            },
            grounded: bool(false),
            selectable: bool(true),
            replaceable: bool(false),
            breakable: bool(true),
            hidden: bool(false),
            "picking-item": str({ "x-note": "Default: `<block id>.item` (`core:empty` for hidden blocks)." }),
            "ui-layout": str({ "x-note": "Default: the block id." }),
            "inventory-size": int({ minimum: 0, default: 0 }),
            size: {
                type: "array",
                items: { type: "integer", minimum: 1, maximum: 16 },
                minItems: 3,
                maxItems: 3,
                default: [1, 1, 1],
                "x-note":
                    "Each component must be in `[1, 16]` (`EXTENDED_BLOCK_LIMIT`). A `block`-model block with a " +
                    "size other than `[1, 1, 1]` becomes an `aabb` model with a hitbox of that size.",
                defaultSnippets: [{ label: "[x, y, z]", body: ["${1:1}", "${2:2}", "${3:1}"] }],
            },
            "grounding-behaviour": enumOf("GroundingBehaviour", {
                default: "partial",
                "x-note": "Only read when `size` is specified.",
            }),
            fields: {
                type: "object",
                propertyNames: { pattern: "^[^.]" },
                additionalProperties: ref("field"),
                "x-doc": { file: "block-properties.md", mode: "headings", section: "Block fields" },
                "x-note": "Field names must not start with `.`; the total size of all fields must not exceed 240 bytes.",
            },
            "surface-replacement": str({
                "x-md":
                    "Id of the block that replaces this one when it ends up under a placed block " +
                    "(e.g. grass turning into dirt). Default: the block itself.",
            }),
            "overlay-texture": str({
                "x-md":
                    "Texture drawn over the block (name in the `blocks` atlas). Used by the base pack for " +
                    "grass side overlays. Default: none.",
            }),
            "script-name": str(),
            "tick-interval": int({ minimum: 0, default: 1, "x-note": "`0` is treated as `1`." }),
            tags: strArray({
                "x-doc": { file: "block-properties.md", mode: "headings", section: "Tags" },
                uniqueItems: true,
            }),
            // base pack user properties (declared in res/content/base/config/user-props.toml)
            "base:durability": num({
                minimum: 0,
                "x-virtual": true,
                "x-doc": "base:durability",
                "x-note": "User property of the `base` pack.",
            }),
            "base:loot": {
                type: "array",
                "x-virtual": true,
                "x-doc": { file: "block-properties.md", mode: "headings", section: "Loot - *base:loot*" },
                "x-note": "User property of the `base` pack.",
                items: {
                    type: "object",
                    required: ["item"],
                    properties: {
                        item: str({ description: "Item id, e.g. `base:dirt.item`." }),
                        count: int({ minimum: 0, default: 1, description: "Fixed count (ignored when `min` and `max` are set)." }),
                        min: int({ minimum: 0, description: "Minimum count." }),
                        max: int({ minimum: 0, description: "Maximum count." }),
                        chance: num({ minimum: 0, maximum: 1, default: 1.0, description: "Drop probability." }),
                    },
                },
            },
        },
        definitions: {
            hitbox: {
                ...numArray(6),
                "x-doc": { file: "block-properties.md", mode: "headings", section: "*hitbox*" },
                default: [0, 0, 0, 1, 1, 1],
                defaultSnippets: [
                    { label: "full block", body: [0, 0, 0, 1, 1, 1] },
                    { label: "[x, y, z, w, h, d]", body: ["${1:0}", "${2:0}", "${3:0}", "${4:1}", "${5:1}", "${6:1}"] },
                ],
            },
            textureFaces: {
                type: "array",
                items: { type: "string" },
                minItems: 6,
                maxItems: 6,
                "x-doc": { file: "block-properties.md", mode: "headings", section: "*texture-faces*" },
                "x-note": "Face order: `-x` (west), `+x` (east), `-y` (bottom), `+y` (top), `-z` (north), `+z` (south).",
                defaultSnippets: [
                    {
                        label: "six faces",
                        body: ["${1:side}", "${1:side}", "${2:bottom}", "${3:top}", "${1:side}", "${1:side}"],
                    },
                ],
            },
            modelPrimitives: {
                type: "object",
                additionalProperties: false,
                deprecationMessage: "model-primitives is deprecated: use a VCM model and model-name.",
                "x-doc": { file: "block-models.md", mode: "headings", section: "Block Models (deprecated)" },
                properties: {
                    aabbs: {
                        type: "array",
                        description: "[x, y, z, width, height, depth] + optionally 1 texture or 6 textures.",
                        items: {
                            type: "array",
                            minItems: 6,
                            items: [
                                num(), num(), num(), num(), num(), num(),
                                str(), str(), str(), str(), str(), str(),
                            ],
                            additionalItems: false,
                            not: { minItems: 8, maxItems: 11 },
                        },
                    },
                    tetragons: {
                        type: "array",
                        description: "[x, y, z, xw.x, xw.y, xw.z, yh.x, yh.y, yh.z, texture]",
                        items: {
                            type: "array",
                            minItems: 10,
                            maxItems: 10,
                            items: [num(), num(), num(), num(), num(), num(), num(), num(), num(), str()],
                        },
                    },
                },
            },
            variant: {
                type: "object",
                additionalProperties: false,
                "x-docs": [{ file: "block-properties.md", mode: "headings" }],
                allOf: [textureExclusion],
                properties: variantProps(),
            },
            field: {
                type: "object",
                additionalProperties: false,
                required: ["type"],
                properties: {
                    type: {
                        type: "string",
                        "x-enum-regex": { file: "src/data/StructLayout.cpp", regex: '\\{"(\\w+)", FieldType::' },
                        description: "Data type.",
                    },
                    length: int({ minimum: 1, default: 1, description: "Array length (number of elements)." }),
                    "convert-strategy": {
                        type: "string",
                        default: "reset",
                        "x-enum-regex": { file: "src/data/StructLayout.cpp", regex: '\\{"(\\w+)", FieldConvertStrategy::' },
                        description:
                            "What happens to values out of range when the field type is narrowed: `reset` sets " +
                            "them to 0, `clamp` clamps them to the new range.",
                    },
                },
            },
        },
    },
};
