// VCM / VCA element and attribute specification.
// VCM: src/coders/vcm.cpp (perform_box/rect/triangle/bone, part handling)
//      and doc/en/vcm.md.
// VCA: res/modules/internal/formats/vca.lua (parse_track, parse_curve,
//      parse_configure), res/modules/internal/animation_codegen.lua and doc/en/vca.md.

export type AttrType =
    | "vec3" | "vec3or4" | "vec2" | "vec4" | "uv" | "texture" | "shading" | "enum" | "sides"
    | "string" | "number" | "integer" | "expr" | "curve" | "axis" | "rotation-order" | "word";

export interface AttrSpec {
    name: string;
    type: AttrType;
    doc: string;
    values?: string[];
    required?: boolean;
}

export interface ElementSpec {
    tag: string;
    doc: string;
    attributes: AttrSpec[];
    /** Allowed child element tags; undefined = no children used by the engine. */
    children?: string[];
}

export const SIDES = ["top", "bottom", "north", "south", "east", "west"];

const texture = (doc = "The texture to display. Default: `$0`. Example: `texture \"blocks:sand\"`"): AttrSpec =>
    ({ name: "texture", type: "texture", doc });
const shading: AttrSpec = {
    name: "shading", type: "shading", values: ["on", "off"],
    doc: "Determines whether shading is enabled on the primitive. Only the literal `off` disables it. Example: `shading off`",
};
const region: AttrSpec = {
    name: "region", type: "vec4",
    doc: "UV region within the selected texture, defined by the positions of opposite corners. Example: `region (0,0,1,1)`",
};
const regionScale: AttrSpec = {
    name: "region-scale", type: "vec2",
    doc: "Multiplier vector for the (automatically selected) UV region. Example: `region-scale (0.5,1)`",
};
const normal: AttrSpec = { name: "normal", type: "vec3", doc: "Overrides the normal vector. Example: `normal (0,1,0)`" };
const cullFace: AttrSpec = {
    name: "cull-face", type: "enum", values: ["back", "front", "off"],
    doc: "Determines which side will be culled. Example: `cull-face front` or `cull-face off` (disables face culling). Default: `back`",
};
const rotate: AttrSpec = {
    name: "rotate", type: "vec3or4",
    doc: "Rotation around the (x,y,z) axes in degrees, or a quaternion (x,y,z,w). Example: `rotate (45,0,0)` or `rotate (0.3826834, 0, 0, 0.9238795)`",
};

const PRIMITIVES = ["box", "rect", "tri", "bone"];

export const VCM_ELEMENTS: ElementSpec[] = [
    {
        tag: "box",
        doc: "Describes a rectangular parallelepiped.",
        children: ["part"],
        attributes: [
            { name: "from", type: "vec3", required: true, doc: "The primitive's origin. Example: `from (0,0,0)`" },
            { name: "to", type: "vec3", required: true, doc: "The point opposite the origin. Example: `to (1,1,1)`" },
            { name: "origin", type: "vec3", doc: "The point relative to which the rotation will be applied. Default: the center of the primitive. Example: `origin (0.5,0.5,0.5)`" },
            rotate,
            texture("The default texture to display for all sides. Default: `$<side index>`."),
            shading,
            { name: "delete", type: "sides", values: SIDES, doc: "Deletes sides by name (top, bottom, east, west, north, south). Example: `delete (top,bottom)`" },
        ],
    },
    {
        tag: "rect",
        doc: "Describes a parallelogram using the right and up vectors.",
        attributes: [
            { name: "from", type: "vec3", required: true, doc: "The origin of the primitive. Example: `from (0,0.5,0.125)`" },
            { name: "right", type: "vec3", required: true, doc: "The X vector, which also determines the width of the primitive. Example: `right (1,0,0)`" },
            { name: "up", type: "vec3", required: true, doc: "The Y vector, which also determines the primitive's height. Example: `up (0,1,0)`" },
            texture(),
            region,
            regionScale,
            shading,
            { name: "flip", type: "enum", values: ["h", "v"], doc: "Flips the UV region horizontally or vertically. Example: `flip v`" },
            normal,
            cullFace,
        ],
    },
    {
        tag: "tri",
        doc: "Describes a triangle. By default, texture coordinates are not affected by shape or size.",
        attributes: [
            { name: "a", type: "vec3", required: true, doc: "Point A. Example: `a (0,0,0)`" },
            { name: "b", type: "vec3", required: true, doc: "Point B. Example: `b (1,0,0)`" },
            { name: "c", type: "vec3", required: true, doc: "Point C. Example: `c (1,1,0)`" },
            { name: "uv", type: "uv", doc: "Normalized texture coordinates of the points (6 numbers, 2 per point). Example: `uv (0,0,1,0,1,1)`" },
            texture(),
            region,
            regionScale,
            shading,
            normal,
            cullFace,
        ],
    },
    {
        tag: "part",
        doc: "Describes properties of the sides of the parent `box` with the specified tags (top/bottom/north/south/east/west).",
        attributes: [
            { name: "tags", type: "sides", values: SIDES, required: true, doc: "Determines which sides the properties will be applied to. Example: `tags (top,bottom)`" },
            texture("The texture to display. Default: `$side_index`."),
            region,
            regionScale,
        ],
    },
    {
        tag: "bone",
        doc: "A bone of the model skeleton. Named bones are included in the skeleton (model parts are named `model_name.bone_name`); unnamed bones only transform nested elements.",
        children: PRIMITIVES,
        attributes: [
            { name: "name", type: "string", doc: "The bone name. If omitted, the bone is \"dissolved\": not included in the final skeleton, but transformations are applied." },
            { name: "move", type: "vec3", doc: "Moves nested elements." },
            { name: "scale", type: "vec3", doc: "Scales nested elements. Applied before moving." },
            rotate,
        ],
    },
];

export const VCM_ROOT_CHILDREN = PRIMITIVES;

const by: AttrSpec = { name: "by", type: "axis", values: ["x", "y", "z"], doc: "The scalar value (axis) the directive controls: `x`, `y` or `z`." };
const bone: AttrSpec = { name: "bone", type: "string", doc: "Target bone name (when animating a skeleton)." };
const func: AttrSpec = {
    name: "func", type: "expr",
    doc: "Expression curve `f(t)`, t is time in seconds. Operators `+ - * / % ^`, constant `pi`, functions sin, cos, tan, noise, sign, round, floor, ceil, exp, min, max, sqrt, log, log10, deg, rad, abs. Example: `func (sin(t * 2.5) + pi)`",
};
const curve: AttrSpec = {
    name: "curve", type: "curve", values: ["const", "linear", "bezier"],
    doc: "Keyframe curve kind: `const`, `linear`, `bezier` or a custom curve `.name` declared with `@curve`.",
};
const period: AttrSpec = { name: "period", type: "number", doc: "Repetition period of the keyframe line, in frames." };

const channel = (tag: string, doc: string): ElementSpec => ({
    tag,
    doc,
    children: ["key"],
    attributes: [bone, by, func, curve, period],
});

export const VCA_ELEMENTS: ElementSpec[] = [
    channel("move", "Translates an object/bone."),
    channel("rotate", "Rotates an object/bone (degrees)."),
    channel("scale", "Scales an object/bone (multiplier)."),
    channel("zoom", "Camera zoom (multiplier)."),
    {
        tag: "texture",
        doc: "Change of a dynamically assigned texture (see skeleton:set_texture). Keys hold texture names.",
        children: ["key"],
        attributes: [
            { name: "name", type: "string", required: true, doc: "Texture slot name, e.g. `$0`." },
            bone,
            period,
        ],
    },
    {
        tag: "configure",
        doc: "Animation metadata (applies globally).",
        attributes: [
            { name: "fps", type: "number", doc: "Frame rate, used as the divisor when calculating duration (default 60)." },
            { name: "frames", type: "number", doc: "Number of animation frames, used as the dividend when calculating duration." },
            { name: "duration", type: "number", doc: "Explicit duration in seconds." },
            { name: "rotation-order", type: "rotation-order", values: ["XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"], doc: "Order in which Euler angles are applied. Examples: XYZ, ZYX, YZX." },
        ],
    },
    {
        tag: "curve",
        doc: "Declares a custom curve type, referenced as `curve .name`. `kl`, `kr` (left/right keys) and `t` in [0..1] are available in the expression.",
        attributes: [
            { name: "name", type: "string", required: true, doc: "Curve name." },
            { name: "func", type: "expr", required: true, doc: "Value expression, e.g. `(kl.value + (kr.value - kl.value) * t)`." },
        ],
    },
];

export const VCA_KEY: ElementSpec = {
    tag: "key",
    doc: "A keyframe: frame number `frame` and value `value`; `bezier` keys also need the tangents lx, ly, rx, ry.",
    attributes: [
        { name: "frame", type: "number", required: true, doc: "Frame number." },
        { name: "value", type: "word", required: true, doc: "Keyframe value (number, or a texture name for @texture)." },
        { name: "lx", type: "number", doc: "Bezier left tangent x." },
        { name: "ly", type: "number", doc: "Bezier left tangent y." },
        { name: "rx", type: "number", doc: "Bezier right tangent x." },
        { name: "ry", type: "number", doc: "Bezier right tangent y." },
    ],
};

/** Functions/constants that actually exist in the VCA expression environment (animation_codegen.lua). */
export const VCA_FUNCTIONS = ["sqrt", "min", "max", "deg", "rad", "log", "log10", "floor", "ceil", "sin", "cos", "tan", "abs", "noise", "sign", "round", "exp"];
/** Documented (doc/en/vca.md) but nil in the engine's environment. */
export const VCA_BROKEN: Record<string, string> = {
    rand: "documented, but not exported to the expression environment (animation_codegen.lua math_funcs) — calling it fails",
    noise2d: "documented, but the engine exports 'noise2' (math.noise2 doesn't exist), so neither works",
    noise2: "exported by animation_codegen.lua, but math.noise2 doesn't exist (the function is math.noise2d)",
    e: "documented, but env.e is overwritten with math.e (nil) in animation_codegen.lua, so 'e' evaluates to nil",
};
export const VCA_VARIABLES = ["t", "pi", "intensity", "m"];
export const VCA_CURVE_VARIABLES = ["t", "kl", "kr", "pi"];

export function vcmElement(tag: string): ElementSpec | undefined {
    return VCM_ELEMENTS.find((e) => e.tag === tag);
}

export function vcaElement(tag: string): ElementSpec | undefined {
    return tag === "key" ? VCA_KEY : VCA_ELEMENTS.find((e) => e.tag === tag);
}
