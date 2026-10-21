import { bool, num, strArray, vec3, enumOf, str } from "./_helpers.mjs";

// src/presets/ParticlesPreset.{hpp,cpp}; defaults are the C++ initializers.
export default {
    file: "particles.schema.json",
    title: "VoxelCore particles preset",
    description:
        "Particle emitter settings (a block's `particles` object, a weather `fall.splash`, " +
        "or the `preset` table of `gfx.particles.emit`). All fields are optional.",
    format: "json",
    fileMatch: [], // only referenced from other schemas
    docs: [{ file: "particles.md", mode: "table", table: 0 }],
    extract: [
        {
            file: "src/presets/ParticlesPreset.cpp",
            func: "void ParticlesPreset::deserialize",
            recv: ["src"],
            in: [""],
        },
    ],
    schema: {
        type: "object",
        additionalProperties: false,
        properties: {
            texture: str({ default: "" }),
            frames: strArray({
                default: [],
                "x-note": "When set, the first frame replaces `texture` and `random_sub_uv` is forced to 1.",
            }),
            lighting: bool(true),
            collision: bool(true),
            global_up_vector: bool(false, {
                "x-md": "Use the global up vector instead of the camera-dependent one when orienting particles.",
            }),
            max_distance: num({ default: 32.0, minimum: 0 }),
            spawn_interval: num({ default: 0.1, minimum: 0 }),
            lifetime: num({ default: 5.0, minimum: 0 }),
            lifetime_spread: num({ default: 0.2, minimum: 0, maximum: 1 }),
            velocity: vec3([0, 0, 0]),
            acceleration: vec3([0, -16, 0]),
            explosion: vec3([2, 2, 2]),
            size: vec3([0.1, 0.1, 0.1]),
            size_spread: num({ default: 0.2 }),
            angle_spread: num({ default: 0.0, minimum: 0, maximum: 1 }),
            min_angular_vel: num({ default: 0.0, minimum: 0 }),
            max_angular_vel: num({ default: 0.0, minimum: 0 }),
            spawn_shape: enumOf("ParticleSpawnShape", { default: "ball" }),
            spawn_spread: vec3([0, 0, 0]),
            spawn_offset: vec3([0, 0, 0]),
            random_sub_uv: num({ default: 1.0, exclusiveMinimum: 0, maximum: 1 }),
        },
    },
};
