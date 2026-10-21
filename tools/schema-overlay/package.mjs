import { str, strArray } from "./_helpers.mjs";

export default {
    file: "package.schema.json",
    title: "VoxelCore content pack (package.json)",
    description: "Content pack definition file read by `ContentPack::read` (`src/content/ContentPack.cpp`).",
    format: "json",
    // VS Code globs can't tell a pack root apart: integration applies this
    // schema programmatically to detected pack roots as well.
    fileMatch: ["**/content/*/package.json"],
    docs: [{ file: "content-packs.md", mode: "headings" }],
    extract: [{ file: "src/content/ContentPack.cpp", func: "ContentPack ContentPack::read", recv: ["root"], in: [""] }],
    schema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
            id: {
                type: "string",
                pattern: "^[A-Za-z_][A-Za-z0-9_]{1,23}$",
                minLength: 2,
                maxLength: 24,
                "x-reserved-ids": true,
                "x-md":
                    "Pack id: letters `A-Z a-z`, digits and `_`; must not start with a digit; length 2..24. " +
                    "Reserved ids are rejected. It is also the pack's mount point (`id:path`).",
            },
            title: str({ "x-md": "Pack name shown in the content menu." }),
            version: str({ "x-md": "Pack version, `major.minor[.patch]`." }),
            creator: str({ "x-md": "Pack author. Ignored when `creators` is present." }),
            creators: strArray({ "x-md": "List of authors (joined with `, `). Takes precedence over `creator`." }),
            description: str({ "x-md": "Short description." }),
            source: str({ "x-md": "Source / homepage URL of the pack." }),
            dependencies: {
                type: "array",
                uniqueItems: true,
                items: {
                    type: "string",
                    pattern: "^[!?~]?[A-Za-z_][A-Za-z0-9_]{1,23}(@(>=|<=|>|<)?[^@\s]+)?$",
                    errorMessage:
                        "Expected [!|?|~]pack_id[@[>=|<=|>|<]version], e.g. \"base\", \"~randutil\", \"randutil@>=1.0\".",
                },
                defaultSnippets: [{ label: "dependency", body: ["${1:base}"] }],
                "x-md":
                    "Pack dependencies. Prefix: `!` required (default), `?` optional, `~` weak. A version " +
                    "constraint follows `@` with an optional operator `>=`, `<=`, `>` or `<` (none = exact, " +
                    "`*` = any): `randutil@>=1.0`.",
            },
        },
    },
};
