import { bool, int, str, strArray } from "./_helpers.mjs";

const IL = "src/content/loading/ItemLoader.cpp";

export default {
    file: "item.schema.json",
    title: "VoxelCore item definition",
    description:
        "Item definition (`<pack>/items/**/*.json`), loaded by `ItemLoader.cpp`. Every non-hidden block " +
        "also gets a generated item `<block id>.item`.",
    format: "json",
    fileMatch: ["**/items/**/*.json"],
    docs: [{ file: "item-properties.md", mode: "headings" }],
    luaProperties: "item",
    extract: [
        { file: IL, func: "ContentUnitLoader<ItemDef>::loadUnit", recv: ["root"], in: [""] },
        { file: "src/content/loading/ContentLoadingCommons.hpp", recv: ["root"], in: [""] },
    ],
    schema: {
        type: "object",
        "x-append": true,
        "x-user-props": true,
        properties: {
            parent: str({
                "x-md":
                    "Full id of an item to inherit from (`pack:name`). The parent definition is copied first, " +
                    "then this file's properties are applied on top.",
            }),
            caption: str({
                "x-doc": { file: "item-properties.md", mode: "headings", section: "Caption and Description" },
                "x-note": "Default: generated from the id.",
            }),
            description: str({
                default: "",
                "x-doc": { file: "item-properties.md", mode: "headings", section: "Caption and Description" },
            }),
            "icon-type": {
                type: "string",
                default: "sprite",
                "x-doc": "icon-type",
                "x-enum-regex": { file: IL, regex: 'iconTypeStr == "(\\w+)"' },
            },
            icon: str({
                default: "blocks:notfound",
                "x-doc": "icon-type",
                "x-note": "For `sprite`: `atlas:texture` (e.g. `items:bread`); for `block`: a block id.",
            }),
            "model-name": str({ "x-note": "Default: `<item id>.model`." }),
            "placing-block": str({ default: "core:air" }),
            emission: {
                type: "array",
                items: { type: "integer", minimum: 0, maximum: 15 },
                minItems: 3,
                maxItems: 3,
                default: [0, 0, 0],
                defaultSnippets: [{ label: "[r, g, b]", body: ["${1:15}", "${2:15}", "${3:15}"] }],
            },
            "stack-size": int({ minimum: 1, default: 64 }),
            uses: int({ minimum: -1, maximum: 32767, default: -1, "x-note": "`-1` (default) means the item has no uses counter." }),
            "uses-display": {
                type: "string",
                default: "vbar",
                "x-enum-regex": { file: IL, regex: 'usesDisplayStr == "(\\w+)"' },
            },
            "script-name": str(),
            tags: strArray({
                uniqueItems: true,
                "x-doc": { file: "item-properties.md", mode: "headings", section: "Tags" },
            }),
        },
    },
};
