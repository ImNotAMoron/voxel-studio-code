import { num, str, enumOf, numArray } from "./_helpers.mjs";

export default {
    file: "text3d-preset.schema.json",
    title: "VoxelCore 3D text preset",
    description:
        "3D text display settings (`<pack>/presets/text3d/<name>.toml`, e.g. `res/presets/text3d/player_name.toml`), " +
        "read by `NotePreset::deserialize`; the same table is used by `gfx.text3d.show`.",
    format: "toml",
    fileMatch: ["**/presets/text3d/*.toml"],
    docs: [{ file: "3d-text.md", mode: "table", table: 0 }],
    extract: [{ file: "src/presets/NotePreset.cpp", func: "void NotePreset::deserialize", recv: ["src"], in: [""] }],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            display: enumOf("NoteDisplayMode", {
                default: "static_billboard",
                "x-enum-docs": { file: "3d-text.md", mode: "table", table: 1 },
            }),
            color: numArray(4, { default: [1, 1, 1, 1], items: { type: "number", minimum: 0 } }),
            scale: num({ default: 1.0 }),
            render_distance: num({ default: 32.0, minimum: 0 }),
            xray_opacity: num({ default: 0.0, minimum: 0, maximum: 1 }),
            perspective: num({ default: 1.0, minimum: 0, maximum: 1 }),
            font: str({ default: "" }),
        },
    },
};
