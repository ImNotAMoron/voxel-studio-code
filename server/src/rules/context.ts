import { Node } from "jsonc-parser";
import { ContentIndex, PackInfo, UnitKind } from "../../../shared/content/index";
import { SchemaStore } from "../schemas";
import { LintSettings } from "./registry";
import { Report } from "./report";

export interface LintEnv {
    index: ContentIndex;
    schemas: SchemaStore;
    settings: LintSettings;
    /** True inside the editor (VS Code JSON service already reports schema errors). */
    editor: boolean;
}

export interface FileContext extends LintEnv {
    file: string;
    text: string;
    pack: PackInfo;
    report: Report;
}

const KIND_DOC: Record<UnitKind, string> = { block: "block", item: "item", entity: "entity" };

/**
 * Checks a full unit id reference. Reports `code` when the id is malformed or
 * the unit doesn't exist in a known pack; ids of packs that aren't available
 * at all are reported as a warning (the dependency rule covers the cause).
 */
export function checkUnitRef(ctx: FileContext, code: string, kind: UnitKind, id: string, node: Node | undefined, what: string) {
    const colon = id.indexOf(":");
    if (colon < 0) {
        ctx.report.node(code, node, `${what} '${id}' must be a full id 'pack:name'`);
        return;
    }
    if (ctx.index.getUnit(kind, id)) return;
    const packId = id.slice(0, colon);
    let hint = "";
    if (kind === "item" && ctx.index.blocks.has(id)) hint = ` (did you mean the block item '${id}.item'?)`;
    else if (kind === "item" && id.endsWith(".item") && ctx.index.blocks.has(id.slice(0, -5))) {
        hint = " (the block is hidden, so it has no item)";
    }
    if (!ctx.index.packs.has(packId)) {
        ctx.report.node(code, node, `${what} '${id}': pack '${packId}' is not available`, { severity: "warning" });
        return;
    }
    ctx.report.node(code, node, `${what} '${id}': no such ${KIND_DOC[kind]}${hint}`, {
        data: { kind, id },
    });
}
