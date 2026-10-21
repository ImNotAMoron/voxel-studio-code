// Pack manifest detection, kept free of `vscode` imports for unit tests.

export interface PackManifest {
    id: string;
    title?: string;
    dependencies: string[];
}

/**
 * A pack-shaped package.json has a string `id` and, unlike npm manifests,
 * its `dependencies` (if any) is an array.
 */
export function parsePackManifest(text: string): PackManifest | undefined {
    try {
        const json = JSON.parse(text);
        if (!json || typeof json !== "object" || typeof json.id !== "string") return undefined;
        if (json.dependencies !== undefined && !Array.isArray(json.dependencies)) return undefined;
        return {
            id: json.id,
            title: typeof json.title === "string" ? json.title : undefined,
            dependencies: (json.dependencies ?? []).filter((d: unknown) => typeof d === "string"),
        };
    } catch {
        return undefined;
    }
}
