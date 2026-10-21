// Rule catalog: ids, default severities and the doc/source each rule cites.

export type Severity = "error" | "warning" | "information" | "hint";
export type SeverityOverride = Severity | "off";

export const DOC_BASE = "https://github.com/MihailRis/VoxelCore/blob/main/";

export interface RuleInfo {
    id: string;
    severity: Severity;
    title: string;
    /** Path relative to the repo root, e.g. `doc/en/block-properties.md#hitbox`. */
    doc: string;
    /** Only reported by the CLI (the editor gets these from JSON Schemas). */
    cliOnly?: boolean;
}

const rules: RuleInfo[] = [
    // pack identity
    { id: "VC0001", severity: "error", title: "invalid content-pack id", doc: "doc/en/content-packs.md" },
    { id: "VC0002", severity: "warning", title: "pack folder name differs from id", doc: "doc/en/content-packs.md" },
    { id: "VC0003", severity: "warning", title: "invalid version format", doc: "doc/en/content-packs.md" },
    { id: "VC0004", severity: "error", title: "invalid dependency", doc: "doc/en/content-packs.md" },
    { id: "VC0005", severity: "error", title: "unresolved dependency", doc: "src/content/PacksManager.cpp" },
    { id: "VC0006", severity: "hint", title: "pack icon missing or not 128x128", doc: "doc/en/content-packs.md" },
    { id: "VC0007", severity: "error", title: "file is not valid JSON/TOML", doc: "doc/en/content-packs.md" },
    // silent drops
    { id: "VC0010", severity: "warning", title: "unknown property (silently ignored)", doc: "res/scripts/post_content.lua", cliOnly: true },
    { id: "VC0011", severity: "warning", title: "undeclared user property (silently dropped)", doc: "doc/en/block-properties.md#user-properties" },
    { id: "VC0012", severity: "information", title: "definition file skipped (leading '_')", doc: "src/content/ContentLoader.cpp" },
    { id: "VC0013", severity: "warning", title: "content.json edited by hand", doc: "src/content/ContentLoader.cpp" },
    // references
    { id: "VC0020", severity: "warning", title: "texture not found", doc: "doc/en/block-properties.md#texture" },
    { id: "VC0021", severity: "warning", title: "item icon not found", doc: "doc/en/item-properties.md#icon-type-and-icon-itself" },
    { id: "VC0022", severity: "error", title: "model not found", doc: "doc/en/block-properties.md#model-name" },
    { id: "VC0023", severity: "warning", title: "block model texture outside the blocks atlas", doc: "doc/en/block-properties.md#model-name" },
    { id: "VC0024", severity: "warning", title: "block material not found", doc: "doc/en/block-properties.md#material---material" },
    { id: "VC0025", severity: "error", title: "sound not found", doc: "doc/en/assets-preload.md" },
    { id: "VC0026", severity: "error", title: "content unit not found", doc: "doc/en/block-properties.md" },
    { id: "VC0027", severity: "warning", title: "tag entry names an unknown unit", doc: "src/content/ContentLoader.cpp" },
    { id: "VC0028", severity: "warning", title: "hidden block without picking-item", doc: "doc/en/block-properties.md#hidden" },
    { id: "VC0029", severity: "warning", title: "block inventory without UI layout", doc: "doc/en/block-properties.md#ui-layout" },
    { id: "VC0030", severity: "warning", title: "script not found", doc: "doc/en/item-properties.md#script-name" },
    { id: "VC0031", severity: "error", title: "entity component not found", doc: "doc/en/entity-properties.md#components" },
    { id: "VC0032", severity: "error", title: "skeleton not found", doc: "doc/en/entity-properties.md#skeleton-name" },
    { id: "VC0033", severity: "error", title: "skeleton bone model not found", doc: "doc/en/rigging.md" },
    { id: "VC0034", severity: "warning", title: "duplicate bone name", doc: "doc/en/rigging.md" },
    { id: "VC0035", severity: "error", title: "structure fragment not found", doc: "doc/en/world-generator.md#structures" },
    { id: "VC0036", severity: "error", title: "unresolved generator reference", doc: "doc/en/world-generator.md#biomes" },
    { id: "VC0037", severity: "error", title: "biome has fewer parameters than biome-parameters", doc: "doc/en/world-generator.md#biome-parameters" },
    { id: "VC0038", severity: "error", title: "more than one resizeable layer", doc: "doc/en/world-generator.md#biomes" },
    { id: "VC0039", severity: "error", title: "preload entry not found", doc: "doc/en/assets-preload.md" },
    { id: "VC0040", severity: "error", title: "UI layout not found", doc: "doc/en/block-properties.md#ui-layout" },
    // value sanity
    { id: "VC0050", severity: "warning", title: "hitbox outside block size", doc: "doc/en/block-properties.md#hitbox" },
    { id: "VC0051", severity: "warning", title: "emission out of range 0..15", doc: "doc/en/block-properties.md#emission" },
    { id: "VC0052", severity: "error", title: "invalid block fields", doc: "doc/en/block-properties.md#block-fields" },
    { id: "VC0053", severity: "error", title: "invalid state-based configuration", doc: "doc/en/block-properties.md#variants" },
    { id: "VC0054", severity: "warning", title: "tick-interval must be positive", doc: "src/content/loading/BlockLoader.cpp" },
    { id: "VC0055", severity: "information", title: "solid has no effect without a custom model", doc: "doc/en/block-properties.md#solid" },
    { id: "VC0056", severity: "warning", title: "invalid texture-faces", doc: "doc/en/block-properties.md#texture-faces" },
    { id: "VC0057", severity: "error", title: "custom model without model-name", doc: "src/content/loading/BlockLoader.cpp" },
    { id: "VC0058", severity: "error", title: "invalid block size", doc: "doc/en/block-properties.md#size" },
    // hygiene
    { id: "VC0060", severity: "hint", title: "unused texture", doc: "doc/en/block-properties.md#texture" },
    { id: "VC0061", severity: "hint", title: "unused sound", doc: "doc/en/assets-preload.md" },
    { id: "VC0062", severity: "hint", title: "unused model", doc: "doc/en/block-properties.md#model-name" },
    { id: "VC0063", severity: "hint", title: "script not used by any unit", doc: "doc/en/scripting.md" },
    // Lua
    { id: "VC0100", severity: "error", title: "Lua syntax error", doc: "doc/en/scripting.md" },
    { id: "VC0101", severity: "warning", title: "callback never called by the engine", doc: "doc/en/scripting/events.md" },
    { id: "VC0102", severity: "error", title: "library unavailable in generator scripts", doc: "doc/en/world-generator.md" },
    { id: "VC0103", severity: "error", title: "module not found", doc: "doc/en/scripting.md" },
    { id: "VC0104", severity: "warning", title: "module does not end with return", doc: "doc/en/scripting.md" },
    { id: "VC0105", severity: "warning", title: "deprecated function", doc: "res/modules/internal/deprecated.lua" },
    { id: "VC0106", severity: "error", title: "core:internal modules are locked", doc: "res/scripts/stdmin.lua" },
    // VCM
    { id: "VC0200", severity: "error", title: "VCM/VCA syntax error", doc: "doc/en/vcm.md" },
    { id: "VC0201", severity: "warning", title: "unknown element (ignored)", doc: "doc/en/vcm.md" },
    { id: "VC0202", severity: "warning", title: "unknown attribute (ignored)", doc: "doc/en/vcm.md" },
    { id: "VC0203", severity: "error", title: "invalid vector/number value", doc: "doc/en/vcm.md" },
    { id: "VC0204", severity: "warning", title: "invalid enumeration value", doc: "doc/en/vcm.md" },
    { id: "VC0205", severity: "warning", title: "texture not found", doc: "doc/en/vcm.md" },
    { id: "VC0206", severity: "information", title: "auto UV on a primitive larger than 1", doc: "doc/en/vcm.md" },
    { id: "VC0207", severity: "warning", title: "duplicate bone name", doc: "doc/en/vcm.md#skeleton" },
    { id: "VC0208", severity: "hint", title: "unnamed bone is dissolved", doc: "doc/en/vcm.md#bone-properties" },
    { id: "VC0209", severity: "error", title: "missing required attribute", doc: "src/coders/vcm.cpp" },
    // VCA
    { id: "VC0220", severity: "error", title: "unknown VCA directive", doc: "doc/en/vca.md#animation-directives" },
    { id: "VC0221", severity: "warning", title: "unknown VCA attribute", doc: "doc/en/vca.md" },
    { id: "VC0222", severity: "warning", title: "invalid 'by' axis", doc: "doc/en/vca.md" },
    { id: "VC0223", severity: "error", title: "unknown curve", doc: "doc/en/vca.md#keyframe-curves" },
    { id: "VC0224", severity: "error", title: "invalid func expression", doc: "doc/en/vca.md#expression-curves" },
    { id: "VC0225", severity: "warning", title: "incomplete keyframe", doc: "doc/en/vca.md#keyframe-curves" },
    { id: "VC0226", severity: "warning", title: "invalid rotation-order", doc: "doc/en/vca.md#metadata" },
];

export const RULES = new Map(rules.map((r) => [r.id, r]));

export function ruleHref(id: string): string {
    return DOC_BASE + (RULES.get(id)?.doc ?? "doc/en/main-page.md");
}

export interface LintSettings {
    /** Report unknown-key diagnostics (CLI; the editor gets them from JSON Schemas). */
    unknownKeys?: boolean;
    /** Rule id -> severity override. */
    rules?: Record<string, SeverityOverride>;
}

export function effectiveSeverity(id: string, settings?: LintSettings): Severity | undefined {
    const override = settings?.rules?.[id];
    if (override === "off") return undefined;
    return override ?? RULES.get(id)?.severity ?? "warning";
}
