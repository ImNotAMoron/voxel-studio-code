// Computes workspace settings that the static `jsonValidation` contribution
// can't express: TOML schema associations (Even Better TOML resolves only
// absolute URLs) and package.json/content.json of pack roots outside
// `content/` folders. Pure functions, no vscode import.

export interface CatalogEntry {
    schema: string;
    format: "json" | "toml";
    fileMatch?: string[];
    regexMatch?: string[];
    refOnly?: boolean;
}

/**
 * An entry is ours when its URL is a file URL to one of our schema files
 * (any extension version or dev checkout).
 */
export function isOurSchemaUrl(url: unknown, schemaFiles: string[]): boolean {
    if (typeof url !== "string" || !url.startsWith("file:")) return false;
    return schemaFiles.some((file) => url.endsWith(`/schemas/${file}`));
}

export function tomlAssociations(
    catalog: CatalogEntry[],
    schemaUrl: (file: string) => string,
    existing: Record<string, string> = {}
): Record<string, string> {
    const files = catalog.map((e) => e.schema);
    const result: Record<string, string> = {};
    for (const [regex, url] of Object.entries(existing)) {
        if (!isOurSchemaUrl(url, files)) result[regex] = url;
    }
    for (const entry of catalog) {
        if (entry.format !== "toml" || entry.refOnly) continue;
        for (const regex of entry.regexMatch ?? []) {
            result[regex] = schemaUrl(entry.schema);
        }
    }
    return result;
}

export interface JsonSchemaSetting {
    fileMatch: string[];
    url: string;
}

/**
 * `json.schemas` entries for pack roots. `packRoots` are workspace-relative
 * POSIX paths ("" for a pack at the workspace root).
 */
export function packRootJsonSchemas(
    packRoots: string[],
    schemaUrl: (file: string) => string,
    existing: JsonSchemaSetting[] = []
): JsonSchemaSetting[] {
    const files = ["package.schema.json", "content.schema.json"];
    const result = existing.filter((s) => !isOurSchemaUrl(s?.url, files));
    const prefix = (root: string) => (root ? `/${root}/` : "/");
    const roots = [...new Set(packRoots)].sort();
    if (roots.length > 0) {
        result.push({
            fileMatch: roots.map((r) => `${prefix(r)}package.json`),
            url: schemaUrl("package.schema.json"),
        });
        result.push({
            fileMatch: roots.map((r) => `${prefix(r)}content.json`),
            url: schemaUrl("content.schema.json"),
        });
    }
    return result;
}

export function sameJson(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
