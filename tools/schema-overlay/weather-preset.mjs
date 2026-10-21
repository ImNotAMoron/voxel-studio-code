import { bool, num, str, vec3 } from "./_helpers.mjs";

const WP = "src/presets/WeatherPreset.cpp";
const doc = (table) => [{ file: "scripting/builtins/libgfx-weather.md", mode: "table", table }];

export default {
    file: "weather-preset.schema.json",
    title: "VoxelCore weather preset",
    description:
        "Weather preset (`<pack>/presets/weather/<name>.json`), read by `WeatherPreset::deserialize`; the same " +
        "table is passed to `gfx.weather.change`.",
    format: "json",
    fileMatch: ["**/presets/weather/*.json"],
    docs: doc(0),
    extract: [
        { file: WP, func: "void WeatherPreset::deserialize", recv: ["src"], in: [""] },
        { file: WP, func: "void WeatherPreset::deserialize", recv: ["froot"], in: ["/properties/fall"] },
    ],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            fall: {
                type: "object",
                additionalProperties: false,
                "x-docs": doc(1),
                properties: {
                    texture: str({ default: "" }),
                    noise: str({ default: "" }),
                    vspeed: num({ default: 1.0 }),
                    hspeed: num({ default: 0.1 }),
                    scale: num({ default: 0.1 }),
                    min_opacity: num({ default: 0.0, minimum: 0 }),
                    max_opacity: num({ default: 1.0, minimum: 0 }),
                    max_intensity: num({ default: 1.0, minimum: 0 }),
                    opaque: bool(false),
                    splash: { $ref: "particles.schema.json" },
                },
            },
            clouds: num({ default: 0.0, minimum: 0, maximum: 1 }),
            fog_opacity: num({ default: 0.0, minimum: 0, maximum: 1 }),
            fog_dencity: num({ default: 1.0, "x-note": "Spelled `dencity` (sic) by the engine." }),
            fog_curve: num({ default: 1.0 }),
            thunder_rate: num({ default: 0.0, minimum: 0, maximum: 1 }),
            sky_tint: vec3([1, 1, 1]),
            clouds_tint: vec3([1, 1, 1]),
            min_sky_light: vec3([0.2, 0.25, 0.33]),
        },
    },
};
