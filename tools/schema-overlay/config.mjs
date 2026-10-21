// Small pack config files: config/defaults.toml, config/user-props.toml,
// config/bindings.toml, tags.toml, project.toml.
import { str, strArray } from "./_helpers.mjs";

export const defaults = {
    file: "defaults.schema.json",
    title: "VoxelCore config/defaults.toml",
    description:
        "Overrides of default content bindings (`<pack>/config/defaults.toml`). It is a combined object: " +
        "values from later-loaded packs win.",
    format: "toml",
    fileMatch: ["**/config/defaults.toml"],
    extract: [
        { file: "src/content/ContentBuilder.cpp", recv: ["defaults"], in: [""] },
        { file: "src/objects/Player.cpp", recv: ["defaults"], in: [""] },
        { file: "src/graphics/render/WorldRenderer.cpp", recv: ["content.getDefaults()"], in: [""] },
        { file: "src/logic/scripting/lua/libs/libgeneration.cpp", recv: ["combined"], in: [""] },
    ],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            generator: str({ "x-md": "Default world generator id (`core:default`, base: `base:demo`)." }),
            "player-entity": str({ "x-md": "Entity id used for players (base: `base:player`). Empty: no entity." }),
            "hand-skeleton": str({ "x-md": "Skeleton id used to render the first-person hand (base: `base:hand`)." }),
            "block-material": str({ "x-md": "Material used by blocks without `material` (base: `base:stone`)." }),
        },
    },
};

export const userProps = {
    file: "user-props.schema.json",
    title: "VoxelCore config/user-props.toml",
    description:
        "Declares user properties allowed in block and item definitions (`<pack>/config/user-props.toml`). " +
        "Undeclared properties are removed from `block.properties` / `item.properties` by " +
        "`res/scripts/post_content.lua`.",
    format: "toml",
    fileMatch: ["**/config/user-props.toml"],
    docs: [{ file: "block-properties.md", mode: "headings" }],
    schema: {
        type: "object",
        propertyNames: {
            pattern: "^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_.-]+$",
            errorMessage: "User property names must be namespaced: \"pack:property_name\".",
        },
        additionalProperties: {
            type: "object",
            description: "Property declaration (currently an empty table: `\"pack:prop\" = {}`).",
        },
    },
};

export const tags = {
    file: "tags.schema.json",
    title: "VoxelCore tags.toml",
    description:
        "Attaches tags to blocks and items of any pack (`<pack>/tags.toml`): `\"prefix:tag\" = [\"pack:block\", ...]`. " +
        "Tagging a block also tags its generated item.",
    format: "toml",
    fileMatch: ["**/tags.toml"],
    schema: {
        type: "object",
        additionalProperties: strArray({
            description: "Block or item ids receiving the tag.",
            items: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*:\\S+$" },
        }),
    },
};

// bindings.toml: [section] name = "key:<code>" | "mouse:<code>"; the values
// are filled in by the generator from src/window/input.cpp ("x-binding-codes").
export const bindings = {
    file: "bindings.schema.json",
    title: "VoxelCore config/bindings.toml",
    description:
        "Input bindings (`<pack>/config/bindings.toml`, also `res/config/bindings.toml`): `section.name = " +
        "\"key:<key>\"` or `\"mouse:<button>\"`. The binding id is `section.name`.",
    format: "toml",
    fileMatch: ["**/config/bindings.toml"],
    schema: {
        type: "object",
        additionalProperties: {
            type: "object",
            description: "Binding section (first part of the binding id).",
            additionalProperties: { type: "string", "x-binding-codes": true },
        },
    },
};

export const project = {
    file: "project.schema.json",
    title: "VoxelCore project.toml",
    description:
        "Project definition (`<project>/project.toml`, see `res/project/`), read by `Project::deserialize` " +
        "(`src/devtools/Project.cpp`).",
    format: "toml",
    fileMatch: ["**/project.toml"],
    extract: [{ file: "src/devtools/Project.cpp", func: "void Project::deserialize", recv: ["src"], in: [""] }],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            name: str({ "x-md": "Project name (id)." }),
            title: str({ "x-md": "Project title shown to the user." }),
            base_packs: strArray({ uniqueItems: true, "x-md": "Content packs always enabled for the project." }),
            permissions: {
                type: "array",
                uniqueItems: true,
                items: { type: "string", "x-enum-regex": { file: "src/devtools/Project.hpp", regex: 'static inline std::string \\w+ = "([\\w-]+)"' } },
                "x-md":
                    "Permissions granted to the project scripts: `debugging` (debug server / sub-instance " +
                    "debugging), `network`, `record-audio`, `write-to-user`, `sub-instances`.",
            },
        },
    },
};

export default [defaults, userProps, tags, bindings, project];
