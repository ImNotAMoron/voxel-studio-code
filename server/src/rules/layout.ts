// Rules for XML UI layouts `layouts/**/*.xml` (FEATURES.md §3.7). Element and
// attribute facts come from shared/layouts (generated from gui_xml.cpp).

import * as path from "node:path";
import { closest } from "../../../shared/content/index";
import { layoutElement, layoutElements, uiNodeTags, type LayoutAttribute } from "../../../shared/layouts";
import { checkLayoutValue } from "../../../shared/layouts/values";
import { parseLayoutXml, type XmlAttribute, type XmlElement, type XmlNode } from "../../../shared/layouts/xml";
import { bindingNames, preloadedFonts, preloadedTextures } from "../features/layoutAssets";
import { callbackLua, layoutScript, packGlobals } from "../features/layoutLua";
import { resolveRef } from "../features/refs";
import { engineGlobals } from "../lua/globals";
import { FileContext } from "./context";

/** `if` / `ifnot` with a falsy value ('', 'false', 'nil') skip the element (UiXmlReader::readUINode). */
function skippedByCondition(element: XmlElement): boolean {
    const falsy = (v: string) => v === "" || v === "false" || v === "nil";
    for (const a of element.attributes) {
        if (a.value.includes("%{")) continue; // a template placeholder
        if (a.name === "if" && falsy(a.value)) return true;
        if (a.name === "ifnot" && !falsy(a.value)) return true;
    }
    return false;
}

/** Elements (registered or sub-elements) that read this attribute. */
function readersOf(attr: string): string[] {
    return Object.entries(layoutElements).filter(([, e]) => Object.hasOwn(e.attributes, attr)).map(([tag]) => tag);
}

/** The tag name inside `</tag>`, for fixes that rename the element. */
function closeTagName(element: XmlElement): { start: number; end: number } | undefined {
    const span = element.closeTagSpan;
    return span && { start: span.start + 2, end: span.start + 2 + element.tag.length };
}

const tagList =(tags: string[]) => tags.slice(0, 4).map((t) => `<${t}>`).join(", ") + (tags.length > 4 ? `, … (${tags.length})` : "");

export function lintLayout(ctx: FileContext) {
    const { report, text } = ctx;
    const doc = parseLayoutXml(text);
    if (doc.errors.length) {
        // the engine stops at the first error; later ones may come from recovery
        const e = doc.errors[0];
        report.add("VC0400", e.span.start, e.span.end, `${e.message}: the engine can't load this layout ("failed to parse layout XML")`, { severity: "error" });
    }
    const root = doc.root;
    if (!root) return;
    if (root.type === "text") {
        report.add("VC0401", root.span.start, root.span.end, "the layout's root is text, not an element: the engine fails with \"unsupported element '#'\"");
        return;
    }
    // `slot` / `slots-grid` are ignored everywhere once an <inventory> was read (UiXmlReader::addIgnore)
    let inventorySeen = false;

    const checkElement = (element: XmlElement, parent: XmlElement | undefined) => {
        const known = layoutElement(element.tag);
        const parentInfo = parent && layoutElement(parent.tag);
        const asUiNode = !parent || (parentInfo?.content.elements ?? false);
        const asSubElement = !!parentInfo?.content.children?.includes(element.tag);
        if (!asUiNode && !asSubElement) {
            if (parentInfo) {
                const why = parentInfo.content.children ? `reads only ${tagList(parentInfo.content.children)} inside` : "doesn't read child elements";
                report.add("VC0403", element.tagSpan.start, element.tagSpan.end, `<${element.tag}> is ignored: <${parent!.tag}> ${why}`, { tags: ["unnecessary"] });
            }
            return false;
        }
        if (!asSubElement) {
            if (skippedByCondition(element)) return false;
            if (known?.parent) {
                if (inventorySeen && known.parent === "inventory") {
                    report.add("VC0403", element.tagSpan.start, element.tagSpan.end, `<${element.tag}> is ignored here: it's only read directly inside <${known.parent}>`, { tags: ["unnecessary"] });
                } else {
                    report.add("VC0401", element.tagSpan.start, element.tagSpan.end,
                        `<${element.tag}> is only read inside <${known.parent}>; here the engine fails with "unsupported element '${element.tag}'"`);
                }
                return false;
            }
            if (!known) {
                const suggestion = closest(element.tag, uiNodeTags());
                report.add("VC0401", element.tagSpan.start, element.tagSpan.end,
                    `unsupported element '${element.tag}': the layout fails to load` + (suggestion ? ` (did you mean <${suggestion}>?)` : ""),
                    { data: suggestion ? { suggestion, closeTag: closeTagName(element) } : undefined });
                return false;
            }
        }
        if (element.tag === "inventory") inventorySeen = true;
        if (element.tag === "select") checkSelected(element);
        // attributes
        const seen = new Map<string, number>();
        element.attributes.forEach((a, i) => seen.set(a.name, i));
        element.attributes.forEach((a, i) => {
            if (seen.get(a.name) !== i) {
                report.add("VC0404", a.nameSpan.start, a.nameSpan.end, `'${a.name}' is set again later in this tag; the engine keeps the last value`, { tags: ["unnecessary"] });
            }
            if (Object.hasOwn(known!.attributes, a.name)) {
                // only the value the engine keeps is read
                if (seen.get(a.name) === i) checkValue(a, known!.attributes[a.name]);
                return;
            }
            const others = readersOf(a.name).filter((t) => t !== element.tag);
            const suggestion = closest(a.name, Object.keys(known!.attributes));
            const hint = others.length && !suggestion ? ` (only ${tagList(others)} read it)` : suggestion ? ` (did you mean '${suggestion}'?)` : "";
            report.add("VC0402", a.nameSpan.start, a.nameSpan.end, `<${element.tag}> doesn't read '${a.name}'; the engine ignores it silently${hint}`,
                { data: suggestion ? { suggestion } : undefined });
        });
        // inner text
        if (!known!.content.text) {
            for (const child of element.children) {
                if (child.type === "text" && child.value.trim()) {
                    report.add("VC0403", child.span.start, child.span.end, `this text is ignored: <${element.tag}> doesn't read inner text`, { tags: ["unnecessary"] });
                }
            }
        }
        return true;
    };

    // Lua callbacks run in the document's environment: the `.xml.lua` script's
    // globals, the engine's, and whatever reaches _G. Templates run in their
    // host document, so their names aren't checked.
    const isTemplate = /[\\/]layouts[\\/]templates[\\/]/.test(ctx.file);
    const script = layoutScript(ctx.file);
    let defined: ((name: string) => boolean) | undefined;
    const isDefined = (name: string) => {
        if (!defined) {
            const engine = engineGlobals(ctx.index.resPath);
            const pack = packGlobals(ctx.pack.root);
            defined = (n) => !!script?.globals.has(n) || engine.has(n) || pack.has(n);
        }
        return defined(name);
    };
    const scriptName = path.basename(ctx.file) + ".lua";
    const checkLua = (a: XmlAttribute, attr: LayoutAttribute) => {
        const lua = callbackLua(text, a, attr.lua!);
        if (!lua) return;
        if (lua.error) {
            const bare = attr.lua!.kind === "chunk" && /^\s*[A-Za-z_][\w.:]*\s*$/.test(a.value);
            if (bare && a.valueSpan) {
                report.add("VC0410", a.valueSpan.start, a.valueSpan.end,
                    `${a.name} is run as Lua statements, and '${a.value.trim()}' alone isn't one: the engine logs a syntax error and the callback does nothing (call it: ${a.value.trim()}())`,
                    { data: { suggestion: `${a.value.trim()}()` } });
                return;
            }
            const how = attr.lua!.kind === "chunk" ? "is run as Lua statements" : `is evaluated as 'return ${a.value.trim()}'`;
            const effect = attr.lua!.kind === "chunk" ? "the engine logs the error and the callback does nothing" : "the engine logs an error each time it's evaluated";
            report.add("VC0410", lua.error.start, lua.error.end, `${a.name} ${how}: ${lua.error.message}; ${effect}`);
            return;
        }
        if (isTemplate) return;
        const reported = new Set<string>();
        for (const g of lua.globals) {
            if (reported.has(g.name) || isDefined(g.name)) continue;
            reported.add(g.name);
            report.add("VC0411", g.start, g.end, script
                ? `'${g.name}' isn't defined in ${scriptName}, by the engine or anywhere in the pack: calling it fails at runtime`
                : `'${g.name}' isn't defined: this layout has no ${scriptName}, and neither the engine nor the pack defines it`);
        }
    };

    // read_select: a `selected` value no option has is shown as the text itself
    const checkSelected = (element: XmlElement) => {
        const selected = element.attributes.filter((a) => a.name === "selected").pop();
        if (!selected || !selected.value || selected.value.includes("%{")) return;
        const options = element.children.filter((c): c is XmlElement => c.type === "element" && c.tag === "option");
        // no options in the layout: a script fills them
        if (!options.length) return;
        const values = options.map((o) => o.attributes.filter((a) => a.name === "value").pop()?.value ?? "");
        if (values.includes(selected.value)) return;
        const suggestion = closest(selected.value, values);
        const span = selected.valueSpan ?? selected.nameSpan;
        report.add("VC0415", span.start, span.end,
            `selected: no <option> has the value '${selected.value}' (${values.map((v) => `'${v}'`).join(", ")}): the select shows '${selected.value}' as its text` +
            (suggestion ? ` (did you mean '${suggestion}'?)` : ""),
            { data: suggestion && selected.valueSpan ? { suggestion } : undefined });
    };

    // names of textures, models, layouts, fonts and bindings
    const checkName = (a: XmlAttribute, attr: LayoutAttribute) => {
        const value = a.value.trim();
        if (!value || value.includes("%{")) return;
        const span = a.valueSpan ?? a.nameSpan;
        const fromPack = ctx.pack.id || undefined;
        switch (attr.type) {
            case "texture": {
                const colon = value.indexOf(":");
                if (colon >= 0) {
                    const atlas = value.slice(0, colon);
                    const name = value.slice(colon + 1);
                    if (!ctx.index.hasTextureFolder(atlas)) {
                        report.add("VC0412", span.start, span.end, `${a.name}: there is no '${atlas}' atlas (textures/${atlas}/ in no pack): the image is drawn as a plain rectangle of its color (Batch2D blank texture)`);
                    } else if (name && !ctx.index.resolveTexture(atlas, name, fromPack)) {
                        report.add("VC0412", span.start, span.end, `${a.name}: texture '${value}' not found (textures/${atlas}/${name}.png): the image is drawn as a plain rectangle of its color (Batch2D blank texture)`);
                    }
                    return;
                }
                if (!ctx.index.resolveTexture("", value, fromPack)) {
                    report.add("VC0412", span.start, span.end, `${a.name}: texture '${value}' not found (textures/${value}.png in no pack): the image is drawn as a plain rectangle of its color (Batch2D blank texture)`);
                } else if (!preloadedTextures(ctx.index).has(value)) {
                    report.add("VC0413", span.start, span.end,
                        `${a.name}: '${value}' isn't in the textures of any preload.json, so it isn't loaded: the image is a plain rectangle of its color unless a script loads it (assets.load_texture)`);
                }
                return;
            }
            case "model":
                if (!resolveRef(ctx.index, "model", value, fromPack)) {
                    report.add("VC0412", span.start, span.end, `${a.name}: model '${value}' not found (models/${value}.vcm, .obj or .vec3)`);
                }
                return;
            case "layout":
                if (!value.includes(":")) {
                    report.add("VC0412", span.start, span.end, `${a.name}: a layout id is 'pack:name' (pack/layouts/name.xml)`);
                } else if (!ctx.index.resolveLayout(value)) {
                    report.add("VC0412", span.start, span.end, `${a.name}: layout '${value}' not found (layouts/${value.slice(value.indexOf(":") + 1)}.xml in pack '${value.slice(0, value.indexOf(":"))}')`);
                }
                return;
            case "font":
                if (!preloadedFonts(ctx.index).has(value)) {
                    const fonts = [...preloadedFonts(ctx.index)];
                    report.add("VC0416", span.start, span.end,
                        `${a.name}: font '${value}' isn't loaded (preload.json fonts: ${fonts.join(", ") || "none"}): the text isn't drawn`,
                        { data: closest(value, fonts) && a.valueSpan ? { suggestion: closest(value, fonts)! } : undefined });
                }
                return;
            case "binding":
                if (!bindingNames(ctx.index).has(value)) {
                    const suggestion = closest(value, bindingNames(ctx.index));
                    report.add("VC0414", span.start, span.end,
                        `${a.name}: binding '${value}' does not exist (config/bindings.toml): the engine throws and the layout fails to load` + (suggestion ? ` (did you mean '${suggestion}'?)` : ""),
                        { data: suggestion && a.valueSpan ? { suggestion } : undefined });
                }
                return;
        }
    };

    const checkValue = (a: XmlAttribute, attr: LayoutAttribute) => {
        if (attr.lua) checkLua(a, attr);
        checkName(a, attr);
        const problem = checkLayoutValue(a.name, attr, a.value);
        if (!problem) return;
        const span = a.valueSpan ?? a.nameSpan;
        // offsets inside the value are exact only when the raw text is the decoded value
        const raw = a.valueSpan && text.slice(a.valueSpan.start, a.valueSpan.end);
        const exact = raw === a.value && problem.start !== undefined;
        const start = exact ? span.start + problem.start! : span.start;
        const end = exact ? span.start + (problem.end ?? a.value.length) : span.end;
        const code = problem.kind === "throws" ? "VC0405" : problem.kind === "unknown" ? "VC0406" : "VC0407";
        const message = problem.kind === "throws" ? `${problem.message}: the layout fails to load` : problem.message;
        // a suggestion replaces the whole value
        const data = problem.suggestion && a.valueSpan ? { suggestion: problem.suggestion } : undefined;
        report.add(code, exact ? start : span.start, exact ? end : span.end, `${a.name}: ${message}`, { data });
    };

    // element ids → `document.<id>` (UiDocument, UINode::getIndices)
    const ids = new Map<string, XmlElement>();
    const checkIds = (element: XmlElement, isRoot: boolean) => {
        const idAttr = element.attributes.filter((a) => a.name === "id").pop();
        const id = idAttr?.value;
        if (!idAttr || !id || id.includes("%{")) return true;
        if (isRoot) {
            report.add("VC0409", idAttr.valueSpan?.start ?? idAttr.nameSpan.start, idAttr.valueSpan?.end ?? idAttr.nameSpan.end,
                `the engine renames the root element to 'root': use document.root, not document.${id}`);
            return true;
        }
        if (id === "root") {
            report.add("VC0408", idAttr.valueSpan!.start, idAttr.valueSpan!.end, "'root' is the layout's root element: document.root never refers to this one");
            return true;
        }
        const first = ids.get(id);
        if (!first) {
            ids.set(id, element);
            return true;
        }
        const line = text.slice(0, first.span.start).split("\n").length;
        const inner = [...descendantIds(element)];
        report.add("VC0408", idAttr.valueSpan!.start, idAttr.valueSpan!.end,
            `id '${id}' is already used on line ${line}: document.${id} is that element` +
            (inner.length ? `; ids inside this element aren't indexed either (${inner.slice(0, 3).map((i) => `'${i}'`).join(", ")}${inner.length > 3 ? ", …" : ""})` : ""));
        return false; // getIndices returns early: nothing below is indexed
    };

    const visit = (node: XmlNode, parent: XmlElement | undefined, indexed: boolean) => {
        if (node.type !== "element") return;
        if (!checkElement(node, parent)) return;
        const below = indexed && checkIds(node, !parent);
        for (const child of node.children) visit(child, node, below);
    };
    visit(root, undefined, true);
}

function* descendantIds(element: XmlElement): Generator<string> {
    for (const child of element.children) {
        if (child.type !== "element") continue;
        const id = child.attributes.filter((a) => a.name === "id").pop()?.value;
        if (id) yield id;
        yield* descendantIds(child);
    }
}
