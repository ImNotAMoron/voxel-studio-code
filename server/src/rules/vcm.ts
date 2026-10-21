// VCM (models) and VCA (animations) semantic validation.

import * as path from "node:path";
import { parse as luaParse } from "luaparse";
import { VcmAttribute, VcmElement, getAttribute, parseVcm, walkVcm } from "../../../shared/vcm/parser";
import { LuaNode, walkLua } from "../lua/analyze";
import {
    AttrSpec, ElementSpec, SIDES, VCA_BROKEN, VCA_CURVE_VARIABLES, VCA_ELEMENTS, VCA_FUNCTIONS, VCA_KEY,
    VCA_VARIABLES, VCM_ROOT_CHILDREN, vcaElement, vcmElement,
} from "../vcm/spec";
import { FileContext } from "./context";
import { Report } from "./report";

/** Offset of the first character of the attribute value text. */
export function valueTextStart(attr: VcmAttribute): number {
    return attr.kind === "word" ? attr.valueSpan.start : attr.valueSpan.start + 1;
}

const FULL_NUMBER = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const PREFIX_NUMBER = /^\s*\+?-?(\d|\.\d|inf|nan)/i;

/** Validates one number like util::parse_double (std::from_chars prefix parse). */
function checkNumber(report: Report, attr: VcmAttribute, part: string, what: string): boolean {
    if (FULL_NUMBER.test(part)) return true;
    if (PREFIX_NUMBER.test(part)) {
        report.add("VC0203", attr.valueSpan.start, attr.valueSpan.end,
            `${what}: '${part.trim()}' is not a plain number (the engine reads only its numeric prefix)`, { severity: "warning" });
        return true;
    }
    report.add("VC0203", attr.valueSpan.start, attr.valueSpan.end, `${what}: invalid number '${part.trim()}' (the engine throws)`);
    return false;
}

/** asVec2/3/4 semantics: a value without commas is broadcast; otherwise exactly N parts. */
function checkVector(report: Report, attr: VcmAttribute, sizes: number[]) {
    const text = attr.value;
    const label = `'${attr.name}'`;
    if (!text.includes(",")) {
        checkNumber(report, attr, text, label);
        return;
    }
    const parts = text.split(",");
    if (!sizes.includes(parts.length)) {
        report.add("VC0203", attr.valueSpan.start, attr.valueSpan.end,
            `${label} expects ${sizes.join(" or ")} comma-separated numbers (or one number to broadcast), got ${parts.length}`);
        return;
    }
    for (const part of parts) if (!checkNumber(report, attr, part, label)) return;
}

function checkEnum(report: Report, attr: VcmAttribute, spec: AttrSpec, note: string) {
    if (spec.values && !spec.values.includes(attr.value)) {
        report.add("VC0204", attr.valueSpan.start, attr.valueSpan.end,
            `invalid ${attr.name} '${attr.value}' (expected ${spec.values.join(", ")}); ${note}`);
    }
}

function checkSides(report: Report, attr: VcmAttribute) {
    for (const raw of attr.value.split(",")) {
        const side = raw.trim();
        if (!SIDES.includes(side)) {
            report.add("VC0204", attr.valueSpan.start, attr.valueSpan.end,
                `unknown side '${side}' is ignored (expected ${SIDES.join(", ")})`);
        }
    }
}

/** Model asset names used by blocks' `model-name` (they must use the blocks atlas). */
function blockModelNames(ctx: FileContext): Set<string> {
    const names = new Set<string>();
    const add = (v: unknown) => {
        if (typeof v === "string") names.add(v);
    };
    for (const block of ctx.index.blocks.values()) {
        for (const json of [block.json, ...block.overrides.map((o) => o.json)]) {
            if (!json) continue;
            add(json["model-name"]);
            const sb = json["state-based"] as { variants?: unknown[] } | undefined;
            if (sb && Array.isArray(sb.variants)) {
                for (const v of sb.variants) if (v && typeof v === "object") add((v as Record<string, unknown>)["model-name"]);
            }
        }
    }
    return names;
}

function modelNameOf(ctx: FileContext): string | undefined {
    const rel = path.relative(path.join(ctx.pack.root, "models"), ctx.file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return rel.split(path.sep).join("/").replace(/\.[^./]+$/, "");
}

function checkTexture(ctx: FileContext, attr: VcmAttribute, blockModel: boolean) {
    const value = attr.value;
    if (value.startsWith("$")) {
        if (!/^\$\d+$/.test(value)) {
            ctx.report.add("VC0205", attr.valueSpan.start, attr.valueSpan.end, `invalid texture placeholder '${value}' (expected $0…$5)`);
        }
        return;
    }
    const colon = value.indexOf(":");
    if (blockModel && !value.startsWith("blocks:")) {
        ctx.report.add("VC0023", attr.valueSpan.start, attr.valueSpan.end,
            `this model is used as a block model: textures must be in the blocks atlas ('blocks:${colon >= 0 ? value.slice(colon + 1) : value}')`);
    }
    if (!ctx.pack.id) return;
    if (colon >= 0) {
        const atlas = value.slice(0, colon);
        if (!ctx.index.hasTextureFolder(atlas)) {
            ctx.report.add("VC0205", attr.valueSpan.start, attr.valueSpan.end, `unknown texture atlas '${atlas}' (no textures/${atlas}/ folder)`);
            return;
        }
    }
    if (!ctx.index.resolveTextureRef(value, ctx.pack.id)) {
        const file = colon >= 0 ? `textures/${value.slice(0, colon)}/${value.slice(colon + 1)}.png` : `textures/${value}.png`;
        ctx.report.add("VC0205", attr.valueSpan.start, attr.valueSpan.end, `texture '${value}' not found (${file})`);
    }
}

function checkAttributes(ctx: FileContext, element: VcmElement, spec: ElementSpec, unknownCode: string, fileKind: string) {
    const { report } = ctx;
    const seen = new Set<string>();
    for (const attr of element.attributes) {
        const attrSpec = spec.attributes.find((a) => a.name === attr.name);
        if (!attrSpec) {
            report.add(unknownCode, attr.nameSpan.start, attr.nameSpan.end,
                `unknown attribute '${attr.name}' for @${element.tag} is ignored (expected: ${spec.attributes.map((a) => a.name).join(", ")})`);
            continue;
        }
        if (seen.has(attr.name)) {
            report.add(unknownCode, attr.nameSpan.start, attr.nameSpan.end, `duplicate attribute '${attr.name}' (the last value wins)`);
        }
        seen.add(attr.name);
        switch (attrSpec.type) {
            case "vec2": checkVector(report, attr, [2]); break;
            case "vec3": checkVector(report, attr, [3]); break;
            case "vec4": checkVector(report, attr, [4]); break;
            case "vec3or4": checkVector(report, attr, [3, 4]); break;
            case "uv": {
                const parts = attr.value.split(",");
                if (parts.length !== 6) {
                    report.add("VC0203", attr.valueSpan.start, attr.valueSpan.end,
                        `'uv' expects 6 numbers (2 per point), got ${parts.length}`, { severity: "warning" });
                }
                for (const part of parts.slice(0, 6)) if (!checkNumber(report, attr, part, "'uv'")) break;
                break;
            }
            case "number":
                checkNumber(report, attr, attr.value, `'${attr.name}'`);
                break;
            case "shading":
                if (attr.value !== "off" && attr.value !== "on") {
                    report.add("VC0204", attr.valueSpan.start, attr.valueSpan.end,
                        `only the literal 'off' disables shading; '${attr.value}' means on`);
                }
                break;
            case "enum":
                checkEnum(report, attr, attrSpec, attr.name === "cull-face" ? "treated as 'back'" : "ignored");
                break;
            case "sides":
                checkSides(report, attr);
                break;
        }
    }
    for (const attrSpec of spec.attributes) {
        if (attrSpec.required && !seen.has(attrSpec.name)) {
            report.add("VC0209", element.tagSpan.start, element.tagSpan.end,
                `@${element.tag} requires attribute '${attrSpec.name}'` + (fileKind === "vcm" ? " (the engine throws)" : ""));
        }
    }
}

function vectorOf(element: VcmElement, name: string): number[] | undefined {
    const attr = getAttribute(element, name);
    if (!attr) return undefined;
    const parts = attr.value.split(",").map((s) => Number(s.trim()));
    if (parts.some((n) => !Number.isFinite(n))) return undefined;
    return parts.length === 1 ? [parts[0], parts[0], parts[0]] : parts;
}

export function lintVcm(ctx: FileContext) {
    const { report } = ctx;
    const doc = parseVcm(ctx.text);
    for (const err of doc.errors) report.add("VC0200", err.span.start, err.span.end, err.message);
    const modelName = modelNameOf(ctx);
    const blockModel = !!modelName && blockModelNames(ctx).has(modelName);
    const boneNames = new Map<string, VcmElement>();

    walkVcm(doc.elements, (element, parent) => {
        const spec = vcmElement(element.tag);
        if (!spec) {
            report.add("VC0201", element.tagSpan.start, element.tagSpan.end,
                `unknown element @${element.tag} is ignored (expected ${[...VCM_ROOT_CHILDREN, "part"].map((t) => "@" + t).join(", ")})`);
            return;
        }
        const allowed = parent ? vcmElement(parent.tag)?.children ?? [] : VCM_ROOT_CHILDREN;
        if (parent && !vcmElement(parent.tag)) return;
        if (!allowed.includes(element.tag)) {
            report.add("VC0201", element.tagSpan.start, element.tagSpan.end, element.tag === "part"
                ? "@part is only used inside @box"
                : `@${element.tag} inside @${parent?.tag} is ignored`);
            return;
        }
        checkAttributes(ctx, element, spec, "VC0202", "vcm");
        const tex = getAttribute(element, "texture");
        if (tex) checkTexture(ctx, tex, blockModel);

        if (element.tag === "bone") {
            const name = getAttribute(element, "name");
            if (!name || name.value === "") {
                report.add("VC0208", element.tagSpan.start, element.tagSpan.end,
                    "unnamed bone is dissolved: it only transforms nested elements and is not part of the skeleton");
            } else if (name.value === "root") {
                report.add("VC0207", name.valueSpan.start, name.valueSpan.end, "bone name 'root' is reserved for the automatic root bone");
            } else if (boneNames.has(name.value)) {
                report.add("VC0207", name.valueSpan.start, name.valueSpan.end, `duplicate bone name '${name.value}' (model parts are keyed by bone name)`);
            } else {
                boneNames.set(name.value, element);
            }
        } else if (element.tag === "rect" && !getAttribute(element, "region")) {
            const right = vectorOf(element, "right");
            const up = vectorOf(element, "up");
            const len = (v?: number[]) => (v && v.length === 3 ? Math.hypot(v[0], v[1], v[2]) : 0);
            if (len(right) > 1 + 1e-6 || len(up) > 1 + 1e-6) {
                report.add("VC0206", element.tagSpan.start, element.tagSpan.end,
                    "automatic UV of a primitive larger than 1.0 is undefined: set 'region' or 'region-scale'");
            }
        } else if (element.tag === "box") {
            const from = vectorOf(element, "from");
            const to = vectorOf(element, "to");
            if (from && to && from.length === 3 && to.length === 3) {
                const d = [0, 1, 2].map((i) => Math.abs(to[i] - from[i]));
                const sideDims = [[d[2], d[1]], [d[2], d[1]], [d[0], d[2]], [d[0], d[2]], [d[0], d[1]], [d[0], d[1]]];
                const covered = new Set<string>();
                for (const part of element.children) {
                    if (part.tag !== "part" || !getAttribute(part, "region")) continue;
                    for (const t of (getAttribute(part, "tags")?.value ?? "").split(",")) covered.add(t.trim());
                }
                const deleted = new Set((getAttribute(element, "delete")?.value ?? "").split(",").map((s) => s.trim()));
                const sides = ["west", "east", "bottom", "top", "north", "south"];
                const big = sides.some((s, i) => !covered.has(s) && !deleted.has(s) && sideDims[i].some((v) => v > 1 + 1e-6));
                if (big) {
                    report.add("VC0206", element.tagSpan.start, element.tagSpan.end,
                        "automatic UV of a primitive larger than 1.0 is undefined: set 'region' on @part elements");
                }
            }
        }
    });
}

// ---- VCA ----

interface ExprIssue {
    start: number;
    end: number;
    message: string;
    severity?: "error" | "warning";
}

/** Validates a VCA `func` expression (Lua expression in the engine). */
export function checkVcaExpression(expr: string, curveContext: boolean): ExprIssue[] {
    const issues: ExprIssue[] = [];
    for (const bad of ["end", "'", '"', "--", ".."]) {
        const i = expr.indexOf(bad);
        if (i >= 0) {
            issues.push({ start: i, end: i + bad.length, message: `'${bad}' is rejected by the engine ("invalid syntax")` });
            return issues;
        }
    }
    const prefix = "return (";
    let chunk: LuaNode;
    try {
        chunk = luaParse(prefix + expr + "\n)", { luaVersion: "LuaJIT", ranges: true, scope: true } as never) as unknown as LuaNode;
    } catch (err) {
        const e = err as { message?: string; index?: number };
        const at = Math.max(0, Math.min((e.index ?? prefix.length) - prefix.length, expr.length));
        issues.push({ start: at, end: at + 1, message: "invalid expression: " + String(e.message ?? err).replace(/^\[\d+:\d+\]\s*/, "") });
        return issues;
    }
    const variables = curveContext ? VCA_CURVE_VARIABLES : VCA_VARIABLES;
    const calls = new Set<LuaNode>();
    walkLua(chunk, (node) => {
        if (node.type === "CallExpression" || node.type === "StringCallExpression" || node.type === "TableCallExpression") {
            calls.add(node.base as LuaNode);
        }
    });
    walkLua(chunk, (node, parent, key) => {
        if (node.type !== "Identifier" || !node.range) return;
        if (parent?.type === "MemberExpression" && key === "identifier") return;
        const name = node.name as string;
        const start = node.range[0] - prefix.length;
        const end = node.range[1] - prefix.length;
        if (calls.has(node)) {
            if (name in VCA_BROKEN) issues.push({ start, end, message: `'${name}': ${VCA_BROKEN[name]}` });
            else if (!VCA_FUNCTIONS.includes(name)) {
                issues.push({ start, end, message: `unknown function '${name}' (available: ${VCA_FUNCTIONS.join(", ")})` });
            }
            return;
        }
        if (name in VCA_BROKEN) issues.push({ start, end, message: `'${name}': ${VCA_BROKEN[name]}`, severity: "warning" });
        else if (!variables.includes(name) && !VCA_FUNCTIONS.includes(name)) {
            issues.push({ start, end, message: `unknown variable '${name}' evaluates to nil (available: ${variables.join(", ")})`, severity: "warning" });
        }
    });
    return issues;
}

export function lintVca(ctx: FileContext) {
    const { report } = ctx;
    const doc = parseVcm(ctx.text);
    for (const err of doc.errors) report.add("VC0200", err.span.start, err.span.end, err.message);
    const curves = new Set<string>();
    for (const el of doc.elements) {
        if (el.tag === "curve") {
            const name = getAttribute(el, "name")?.value;
            if (name) curves.add(name);
        }
    }
    for (const element of doc.elements) {
        const spec = VCA_ELEMENTS.find((e) => e.tag === element.tag);
        if (!spec) {
            report.add("VC0220", element.tagSpan.start, element.tagSpan.end,
                `unknown directive @${element.tag} (the engine throws; expected ${VCA_ELEMENTS.map((e) => "@" + e.tag).join(", ")})`);
            continue;
        }
        checkAttributes(ctx, element, spec, "VC0221", "vca");
        const isChannel = ["move", "rotate", "scale", "zoom"].includes(element.tag);
        const byAttr = getAttribute(element, "by");
        if (["move", "rotate", "scale"].includes(element.tag)) {
            if (!byAttr) {
                report.add("VC0222", element.tagSpan.start, element.tagSpan.end, `@${element.tag} without 'by' (x, y or z) has no effect`);
            } else if (!["x", "y", "z"].includes(byAttr.value)) {
                report.add("VC0222", byAttr.valueSpan.start, byAttr.valueSpan.end, `invalid axis '${byAttr.value}' (expected x, y or z)`);
            }
        }
        const funcAttr = getAttribute(element, "func");
        if (funcAttr) {
            const base = valueTextStart(funcAttr);
            for (const issue of checkVcaExpression(funcAttr.value, element.tag === "curve")) {
                report.add("VC0224", base + issue.start, base + issue.end, issue.message, { severity: issue.severity });
            }
        }
        const curveAttr = getAttribute(element, "curve");
        let interp: string | undefined;
        if (curveAttr && isChannel) {
            interp = curveAttr.value;
            if (interp.startsWith(".")) {
                if (!curves.has(interp.slice(1))) {
                    report.add("VC0223", curveAttr.valueSpan.start, curveAttr.valueSpan.end,
                        `custom curve '${interp.slice(1)}' is not declared with @curve`);
                }
            } else if (!["const", "linear", "bezier"].includes(interp)) {
                report.add("VC0223", curveAttr.valueSpan.start, curveAttr.valueSpan.end,
                    `unknown curve '${interp}' (expected const, linear, bezier or .custom); falls back to linear`, { severity: "warning" });
            }
        }
        if (element.tag === "configure") {
            const order = getAttribute(element, "rotation-order");
            if (order) {
                const v = order.value.toUpperCase();
                if (v.length !== 3 || [...v].sort().join("") !== "XYZ") {
                    report.add("VC0226", order.valueSpan.start, order.valueSpan.end,
                        `invalid rotation-order '${order.value}' (a permutation of XYZ, e.g. XYZ, ZYX)`);
                }
            }
        }
        for (const child of element.children) {
            if (child.tag !== "key") {
                report.add("VC0221", child.tagSpan.start, child.tagSpan.end, `@${child.tag} inside @${element.tag} is read as a keyframe; use @key`);
            }
            checkAttributes(ctx, child, VCA_KEY, "VC0221", "vca");
            if (element.tag !== "texture") {
                const value = getAttribute(child, "value");
                if (value && !/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(value.value)) {
                    report.add("VC0225", value.valueSpan.start, value.valueSpan.end, `keyframe value '${value.value}' is not a number (tonumber gives nil)`);
                }
            }
            if (interp === "bezier") {
                const missing = ["lx", "ly", "rx", "ry"].filter((n) => !getAttribute(child, n));
                if (missing.length) {
                    report.add("VC0225", child.tagSpan.start, child.tagSpan.end, `bezier keyframe needs tangents: missing ${missing.join(", ")}`);
                }
            }
        }
    }
}

export { vcaElement };
