// Shared building blocks for the hand-maintained schema overlays.
//
// Overlay files (`tools/schema-overlay/<name>.mjs`, not starting with `_`)
// export a default object:
//
//   {
//     file: "block.schema.json",       // output name in schemas/
//     title, description,              // schema title + markdown description
//     format: "json" | "toml",
//     fileMatch: [globs],              // catalog / jsonValidation globs
//     docs: [docSource...],            // default doc sources for root properties
//     extract: [extractSpec...],       // loader keys that must be in the schema
//     luaProperties: "block" | "item", // cross-check with res/scripts/post_content.lua
//     schema: { ...JSON Schema with x-* extensions... }
//   }
//
// x-* extensions understood by tools/gen-schemas.mjs (all are removed from the
// output):
//   x-enum: "CullingMode"           enum values from VC_ENUM_METADATA(...) in src/
//   x-enum-regex: {file, regex, extra?}  enum values = capture group 1 of all matches
//   x-docs: [docSource...]          doc sources for this object's properties
//   x-doc: "key" | docSource        override the doc lookup for this property
//   x-md: "markdown"                hand-written description (used if docs lack one)
//   x-note: "markdown"              appended to the description
//   x-append: true                  generate "<prop>@append" keys for list props
//   x-user-props: true              allow namespaced user properties ("pack:prop")
//   x-virtual: true                 property is not read by a C++ loader (no
//                                   "unused overlay key" warning)
//
// docSource: { file: "block-properties.md", mode: "headings"|"table"|"list",
//              section?: "heading title", table?: index, prefix?: "layers" }
//
// extractSpec: { file: "src/...cpp", func?: "literal text locating a function",
//                recv: ["root"], in: ["", "/definitions/variant"], any?: true,
//                ignore?: ["key"] }
//   Every string key read through recv.at("k") / recv.has("k") / recv["k"] /
//   dv::get*(recv, "k") inside the function body must be a property of every
//   (or, with any: true, at least one) object schema addressed by `in`
//   (JSON pointers into the generated schema; "" = root).

export const num = (extra = {}) => ({ type: "number", ...extra });
export const int = (extra = {}) => ({ type: "integer", ...extra });
export const bool = (def, extra = {}) => ({ type: "boolean", default: def, ...extra });
export const str = (extra = {}) => ({ type: "string", ...extra });

export const numArray = (n, extra = {}) => ({
    type: "array",
    items: { type: "number" },
    minItems: n,
    maxItems: n,
    ...extra,
});

export const strArray = (extra = {}) => ({
    type: "array",
    items: { type: "string" },
    ...extra,
});

export const vec3 = (def, extra = {}) =>
    numArray(3, {
        ...(def !== undefined ? { default: def } : {}),
        defaultSnippets: [{ label: "[x, y, z]", body: ["${1:0}", "${2:0}", "${3:0}"] }],
        ...extra,
    });

export const enumOf = (name, extra = {}) => ({ type: "string", "x-enum": name, ...extra });

export const ref = (name) => ({ $ref: `#/definitions/${name}` });

/** Namespaced id such as `base:stone` (pack prefix optional where noted). */
export const ID_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*:[^:\\s]+$";

export const GITHUB = "https://github.com/MihailRis/VoxelCore/blob/main/";
