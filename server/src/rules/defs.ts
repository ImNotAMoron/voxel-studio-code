// Rules for definition files: blocks/, items/, entities/, block_materials/, skeletons/.

import * as path from "node:path";
import { Node } from "jsonc-parser";
import { closest } from "../../../shared/content/index";
import { DefKind, VARIANT_KEYS } from "../schemas";
import { FileContext, checkUnitRef } from "./context";
import { arrayItems, at, bool, keyNode, num, objectEntries, str } from "./report";

const FIELD_TYPE_SIZES: Record<string, number> = {
    int8: 1, int16: 2, int32: 4, int64: 8, float32: 4, float64: 8, char: 1,
};
const MAX_USER_BLOCK_FIELDS_SIZE = 240; // src/voxels/Block.hpp
const BLOCK_MAX_VARIANTS = 16; // src/voxels/Block.hpp
const EXTENDED_BLOCK_LIMIT = 16; // CHUNK_W, src/constants.hpp
const EPS = 1e-4;

/** Unknown keys (CLI only), `pack:prop` user properties and `@method` suffixes. */
export function checkKeys(ctx: FileContext, root: Node, kind: DefKind, userProps: boolean) {
    const known = ctx.schemas.knownKeys(kind);
    const declared = userProps ? ctx.index.userProps() : undefined;
    for (const { key, keyNode: kn } of objectEntries(root)) {
        let name = key;
        const atPos = key.lastIndexOf("@");
        if (atPos >= 0 && (kind === "block" || kind === "item")) {
            const method = key.slice(atPos + 1);
            if (method !== "append") {
                ctx.report.node("VC0010", kn, `unknown property method '@${method}' (only '@append' is supported; the engine throws)`, {
                    severity: "error",
                });
                continue;
            }
            name = key.slice(0, atPos);
        }
        if (name.includes(":") && declared) {
            if (!declared.has(name)) {
                const packId = name.slice(0, name.indexOf(":"));
                ctx.report.node("VC0011", kn,
                    `user property '${name}' is not declared in any config/user-props.toml; ` +
                    "the engine silently drops it from block.properties/item.properties",
                    { data: { prop: name, declarePack: ctx.index.packs.get(packId) && !ctx.index.packs.get(packId)!.builtin ? packId : ctx.pack.id } });
            }
            continue;
        }
        if (ctx.editor || !ctx.settings.unknownKeys) continue;
        if (!known.has(name)) {
            const suggestion = closest(name, known);
            ctx.report.node("VC0010", kn,
                `unknown property '${name}' is silently ignored by the engine` +
                (suggestion ? `; did you mean '${suggestion}'?` : ""),
                { data: suggestion ? { suggestion } : undefined });
        }
    }
}

function checkBlockTexture(ctx: FileContext, node: Node | undefined) {
    const name = str(node);
    if (name === undefined) return;
    if (!ctx.index.resolveTexture("blocks", name, ctx.pack.id)) {
        ctx.report.node("VC0020", node, `block texture '${name}' not found (textures/blocks/${name}.png)`, {
            data: { createTexture: { atlas: "blocks", name } },
        });
    }
}

/** `atlas:name` texture regions (overlay-texture, particles). */
function checkAtlasTexture(ctx: FileContext, node: Node | undefined, what: string) {
    const ref = str(node);
    if (!ref) return;
    const colon = ref.indexOf(":");
    if (colon >= 0) {
        const atlas = ref.slice(0, colon);
        if (!ctx.index.hasTextureFolder(atlas)) return; // unknown atlas: can't verify
    }
    if (!ctx.index.resolveTextureRef(ref, ctx.pack.id)) {
        ctx.report.node("VC0020", node, `${what} '${ref}' not found`);
    }
}

function checkModelName(ctx: FileContext, node: Node | undefined) {
    const name = str(node);
    if (!name || name.includes(":")) return; // prefixed names aren't auto-loaded
    if (!ctx.index.resolveModel(name, ctx.pack.id)) {
        ctx.report.node("VC0022", node, `model '${name}' not found (models/${name}.vcm|.obj|.vec3|.xml in any pack)`);
    }
}

function checkVariant(ctx: FileContext, obj: Node | undefined) {
    if (!obj || obj.type !== "object") return;
    checkBlockTexture(ctx, at(obj, ["texture"]));
    const faces = at(obj, ["texture-faces"]);
    if (faces) {
        if (at(obj, ["texture"])) {
            ctx.report.node("VC0056", keyNode(obj, "texture-faces"), "'texture-faces' is ignored because 'texture' is set");
        }
        const items = arrayItems(faces);
        if (faces.type === "array" && items.length < 6) {
            ctx.report.node("VC0056", faces, `'texture-faces' requires 6 elements, got ${items.length} (the engine throws)`, {
                severity: "error",
            });
        }
        for (const item of items) checkBlockTexture(ctx, item);
    }
    checkModelName(ctx, at(obj, ["model-name"]));
}

function isNumberArray(node: Node | undefined, length: number): number[] | undefined {
    const items = arrayItems(node);
    if (items.length < length) return undefined;
    const values = items.slice(0, length).map(num);
    return values.every((v) => v !== undefined) ? (values as number[]) : undefined;
}

export function lintBlock(ctx: FileContext, root: Node) {
    const { index, report } = ctx;
    checkKeys(ctx, root, "block", true);
    const value = (key: string) => at(root, [key]);
    const hasParent = !!value("parent");

    checkVariant(ctx, root);
    const model = str(value("model"));
    if (model === "custom" && !value("model-name") && !value("model-primitives") && !hasParent) {
        report.node("VC0057", value("model"), "'custom' model requires 'model-name' (or deprecated 'model-primitives'); the engine throws");
    }

    // parent
    const parent = str(value("parent"));
    if (parent !== undefined) checkUnitRef(ctx, "VC0026", "block", parent, value("parent"), "parent");

    // material
    const material = value("material");
    const materialName = str(material);
    if (materialName !== undefined && materialName !== "") {
        if (!materialName.includes(":")) {
            report.node("VC0024", material, `material '${materialName}' must be a full id 'pack:name'`);
        } else if (!index.resolveMaterial(materialName)) {
            const packId = materialName.slice(0, materialName.indexOf(":"));
            report.node("VC0024", material, index.packs.has(packId)
                ? `block material '${materialName}' not found (${packId}/block_materials/${materialName.slice(packId.length + 1)}.json)`
                : `block material '${materialName}': pack '${packId}' is not available`);
        }
    }

    // picking-item / hidden
    const pickingItem = str(value("picking-item"));
    if (pickingItem !== undefined) checkUnitRef(ctx, "VC0026", "item", pickingItem, value("picking-item"), "picking-item");
    if (bool(value("hidden")) === true && pickingItem === undefined && !hasParent) {
        report.node("VC0028", keyNode(root, "hidden"),
            "hidden block has no item: set 'picking-item' (e.g. the visible block's '<id>.item'), otherwise picking gives core:empty");
    }

    // ui-layout / inventory
    const blockId = blockIdOf(ctx);
    const layoutNode = value("ui-layout");
    const layout = str(layoutNode);
    const inventorySize = num(value("inventory-size"));
    if (layout !== undefined) {
        if (!layout.includes(":")) {
            report.node("VC0040", layoutNode, `ui-layout '${layout}' must be a full id 'pack:name'`, { severity: "warning" });
        } else if (!index.resolveLayout(layout)) {
            report.node("VC0040", layoutNode, `UI layout '${layout}' not found (layouts/${layout.slice(layout.indexOf(":") + 1)}.xml)`, {
                severity: "warning",
            });
        }
    } else if (inventorySize !== undefined && inventorySize > 0 && blockId && !index.resolveLayout(blockId) && !hasParent) {
        report.node("VC0029", value("inventory-size"),
            `block has an inventory but no UI layout: add layouts/${blockId.slice(blockId.indexOf(":") + 1)}.xml or set 'ui-layout'`);
    }

    // script-name
    const scriptName = str(value("script-name"));
    if (scriptName !== undefined && !index.resolveScript(ctx.pack.id, scriptName)) {
        report.node("VC0030", value("script-name"), `script 'scripts/${scriptName}.lua' not found in pack '${ctx.pack.id}'`, {
            data: { createScript: { pack: ctx.pack.id, name: scriptName, kind: "block" } },
        });
    }

    // overlay texture, particles
    checkAtlasTexture(ctx, value("overlay-texture"), "overlay texture");
    const particles = value("particles");
    if (particles?.type === "object") {
        checkAtlasTexture(ctx, at(particles, ["texture"]), "particle texture");
        for (const frame of arrayItems(at(particles, ["frames"]))) checkAtlasTexture(ctx, frame, "particle frame");
    }

    // size
    let size = [1, 1, 1];
    const sizeNode = value("size");
    if (sizeNode) {
        const s = isNumberArray(sizeNode, 3);
        if (!s) {
            report.node("VC0058", sizeNode, "'size' must be an array of 3 integers");
        } else if (s.some((v) => v < 1 || v > EXTENDED_BLOCK_LIMIT)) {
            report.node("VC0058", sizeNode, `block size components must be in range [1, ${EXTENDED_BLOCK_LIMIT}] (the engine throws)`);
        } else {
            size = s.map((v) => Math.trunc(v));
        }
    }

    // hitboxes
    const checkHitbox = (node: Node) => {
        const box = isNumberArray(node, 6);
        if (!box) return;
        const [x, y, z, w, h, d] = box;
        const bad = [x, y, z].some((v) => v < -EPS) || [w, h, d].some((v) => v < -EPS) ||
            x + w > size[0] + EPS || y + h > size[1] + EPS || z + d > size[2] + EPS;
        if (bad) {
            report.node("VC0050", node,
                `hitbox [x, y, z, width, height, depth] goes outside the block size [${size.join(", ")}]`);
        }
    };
    if (value("hitboxes")) for (const box of arrayItems(value("hitboxes"))) checkHitbox(box);
    else if (value("hitbox")) checkHitbox(value("hitbox")!);

    // emission
    for (const item of arrayItems(value("emission")).slice(0, 3)) {
        const v = num(item);
        if (v !== undefined && (v < 0 || v > 15)) {
            report.node("VC0051", item, `emission component ${v} is clamped to [0, 15]`);
        }
    }

    // fields
    const fields = value("fields");
    if (fields?.type === "object") {
        let total = 0;
        for (const { key, keyNode: kn, valueNode } of objectEntries(fields)) {
            if (key.startsWith(".")) report.node("VC0052", kn, `user field '${key}' may not start with '.'`);
            const typeNode = at(valueNode, ["type"]);
            const type = str(typeNode);
            if (type === undefined || !(type in FIELD_TYPE_SIZES)) {
                report.node("VC0052", typeNode ?? kn,
                    `field '${key}': unknown type '${type ?? ""}' (expected ${Object.keys(FIELD_TYPE_SIZES).join(", ")})`);
                continue;
            }
            const lengthNode = at(valueNode, ["length"]);
            let length = 1;
            if (lengthNode) {
                const l = num(lengthNode);
                if (l === undefined || l <= 0) {
                    report.node("VC0052", lengthNode, `field '${key}': invalid length`);
                    continue;
                }
                length = Math.trunc(l);
            }
            total += FIELD_TYPE_SIZES[type] * length;
        }
        if (total > MAX_USER_BLOCK_FIELDS_SIZE) {
            report.node("VC0052", keyNode(root, "fields"),
                `fields total size exceeds limit (${total}/${MAX_USER_BLOCK_FIELDS_SIZE} bytes)`);
        }
    }

    // state-based
    const stateBased = value("state-based");
    if (stateBased?.type === "object" && at(stateBased, ["variants"])) {
        const offset = num(at(stateBased, ["offset"])) ?? 0;
        const bits = num(at(stateBased, ["bits"])) ?? 4;
        if (offset < 0 || bits <= 0 || offset + bits > 8) {
            report.node("VC0053", at(stateBased, ["bits"]) ?? at(stateBased, ["offset"]) ?? keyNode(root, "state-based"),
                "invalid state-based bits configuration: need offset >= 0, bits > 0 and offset + bits <= 8 (the engine throws)");
        }
        const variants = at(stateBased, ["variants"]);
        const items = arrayItems(variants);
        if (items.length + 1 > BLOCK_MAX_VARIANTS) {
            report.node("VC0053", variants,
                `too many variants: ${items.length} + the default exceeds the limit of ${BLOCK_MAX_VARIANTS}`);
        } else if (bits > 0 && bits <= 8 && items.length + 1 > 2 ** bits) {
            report.node("VC0053", variants,
                `${items.length + 1} variants (incl. default) can't be addressed with ${bits} bit(s)`, { severity: "warning" });
        }
        for (const item of items) {
            checkVariant(ctx, item);
            if (!ctx.editor && ctx.settings.unknownKeys) {
                for (const { key, keyNode: kn } of objectEntries(item)) {
                    if (!VARIANT_KEYS.includes(key)) {
                        report.node("VC0010", kn, `property '${key}' is not variant-specific and is ignored here`);
                    }
                }
            }
        }
    }

    // tick-interval
    const tick = value("tick-interval");
    const tickValue = num(tick);
    if (tickValue !== undefined && tickValue <= 0) {
        report.node("VC0054", tick, tickValue === 0
            ? "tick-interval 0 is replaced with 1"
            : "tick-interval must be a positive integer");
    }

    // solid without custom model
    if (bool(value("solid")) === true && !hasParent) {
        const effectiveModel = model ?? "block";
        if (effectiveModel !== "custom") {
            report.node("VC0055", keyNode(root, "solid"),
                `'solid' only affects blocks with the 'custom' model (this one uses '${effectiveModel}')`);
        }
    }
}

function blockIdOf(ctx: FileContext): string | undefined {
    const rel = path.relative(path.join(ctx.pack.root, "blocks"), ctx.file).split(path.sep);
    const stem = (s: string) => s.replace(/\.json$/i, "");
    if (rel.length === 1) return `${ctx.pack.id}:${stem(rel[0])}`;
    if (rel.length === 2) return `${rel[0]}:${stem(rel[1])}`;
    return undefined;
}

export function lintItem(ctx: FileContext, root: Node) {
    const { index, report } = ctx;
    checkKeys(ctx, root, "item", true);
    const value = (key: string) => at(root, [key]);
    const parent = str(value("parent"));
    if (parent !== undefined) checkUnitRef(ctx, "VC0026", "item", parent, value("parent"), "parent");

    const iconType = str(value("icon-type")) ?? (parent ? undefined : "sprite");
    const iconNode = value("icon");
    const icon = str(iconNode);
    if (icon !== undefined) {
        if (iconType === "block") {
            checkUnitRef(ctx, "VC0021", "block", icon, iconNode, "icon block");
        } else if (iconType === "sprite") {
            const colon = icon.indexOf(":");
            if (colon < 0) {
                report.node("VC0021", iconNode, `sprite icon '${icon}' must be 'atlas:texture' (e.g. 'items:${icon}')`);
            } else {
                const atlas = icon.slice(0, colon);
                const name = icon.slice(colon + 1);
                if (index.hasTextureFolder(atlas) && !index.resolveTexture(atlas, name, ctx.pack.id)) {
                    report.node("VC0021", iconNode, `icon texture '${icon}' not found (textures/${atlas}/${name}.png)`, {
                        data: atlas === "items" || atlas === "blocks" ? { createTexture: { atlas, name } } : undefined,
                    });
                }
            }
        }
    }
    const placing = str(value("placing-block"));
    if (placing !== undefined && placing !== "") checkUnitRef(ctx, "VC0026", "block", placing, value("placing-block"), "placing-block");

    const scriptName = str(value("script-name"));
    if (scriptName !== undefined && !index.resolveScript(ctx.pack.id, scriptName)) {
        report.node("VC0030", value("script-name"), `script 'scripts/${scriptName}.lua' not found in pack '${ctx.pack.id}'`, {
            data: { createScript: { pack: ctx.pack.id, name: scriptName, kind: "item" } },
        });
    }
    checkModelName(ctx, value("model-name"));
}

export function lintEntity(ctx: FileContext, root: Node) {
    const { index, report } = ctx;
    checkKeys(ctx, root, "entity", false);
    const value = (key: string) => at(root, [key]);
    const parent = str(value("parent"));
    if (parent !== undefined) checkUnitRef(ctx, "VC0026", "entity", parent, value("parent"), "parent");

    for (const item of arrayItems(value("components"))) {
        const nameNode = item.type === "object" ? at(item, ["name"]) : item;
        const name = str(nameNode);
        if (name === undefined) continue;
        const colon = name.indexOf(":");
        if (colon < 0) {
            report.node("VC0031", nameNode, `component '${name}' must be a full id 'pack:name' (e.g. '${ctx.pack.id}:${name}')`);
            continue;
        }
        if (index.resolveComponent(name)) continue;
        const packId = name.slice(0, colon);
        if (!index.packs.has(packId)) {
            report.node("VC0031", nameNode, `component '${name}': pack '${packId}' is not available`, { severity: "warning" });
            continue;
        }
        report.node("VC0031", nameNode,
            `component '${name}' not found (${packId}/scripts/components/${name.slice(colon + 1)}.lua); the engine throws`,
            { data: { createScript: { pack: packId, name: "components/" + name.slice(colon + 1), kind: "component" } } });
    }

    const skeletonNode = value("skeleton-name");
    const skeleton = str(skeletonNode);
    if (skeleton !== undefined) {
        const colon = skeleton.indexOf(":");
        if (colon >= 0) {
            const packId = skeleton.slice(0, colon);
            if (!index.resolveSkeleton(skeleton) && index.packs.has(packId)) {
                report.node("VC0032", skeletonNode,
                    `skeleton '${skeleton}' not found (${packId}/skeletons/${skeleton.slice(colon + 1)}.json)`);
            }
        } else if (!index.resolveModel(skeleton, ctx.pack.id)) {
            report.node("VC0032", skeletonNode,
                `skeleton '${skeleton}' not found: a name without a pack prefix refers to a model with bones ` +
                `(models/${skeleton}.vcm); skeletons/*.json are named 'pack:name'`);
        }
    }
}

export function lintMaterial(ctx: FileContext, root: Node) {
    checkKeys(ctx, root, "material", false);
    for (const key of ["steps-sound", "place-sound", "break-sound", "hit-sound"]) {
        const node = at(root, [key]);
        const name = str(node);
        if (!name) continue;
        if (!ctx.index.resolveSound(name, ctx.pack.id)) {
            ctx.report.node("VC0025", node, `sound '${name}' not found (sounds/${name}.ogg or sounds/${name}_0.ogg)`);
        }
    }
}

export function lintSkeleton(ctx: FileContext, root: Node) {
    checkKeys(ctx, root, "skeleton", false);
    const names = new Map<string, Node>();
    const visit = (node: Node | undefined, depth: number) => {
        if (!node || node.type !== "object" || depth > 64) return;
        const nameNode = at(node, ["name"]);
        const name = str(nameNode);
        if (name) {
            if (names.has(name)) ctx.report.node("VC0034", nameNode, `duplicate bone name '${name}'`);
            else names.set(name, nameNode!);
        }
        const modelNode = at(node, ["model"]);
        let model = str(modelNode);
        if (model) {
            const dot = model.lastIndexOf(".");
            if (dot >= 0) model = model.slice(0, dot);
            if (model && !ctx.index.resolveModel(model, ctx.pack.id)) {
                ctx.report.node("VC0033", modelNode, `bone model '${model}' not found (models/${model}.vcm|.obj|.vec3|.xml)`);
            }
        }
        for (const child of arrayItems(at(node, ["nodes"]))) visit(child, depth + 1);
    };
    visit(at(root, ["root"]), 0);
}
