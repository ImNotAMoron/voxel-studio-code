// XML UI layout elements and attributes (FEATURES.md §3.7), generated from the
// engine's gui_xml.cpp by tools/gen-layouts.mjs. Pure data: no `vscode` import.
import data from "./elements.json";

export type LayoutValueType =
    | "string" | "bool" | "int" | "number" | "vec2" | "vec3" | "vec4" | "color" | "enum" | "lua"
    // strings that name something
    | "id" | "font" | "texture" | "model" | "layout" | "binding" | "locale-context" | "condition";

export interface LuaCallback {
    /** `chunk`: statements run as is; `expression`: evaluated, and called if it's a function. */
    kind: "chunk" | "expression";
    args?: string[];
    returns?: string;
}

export interface LayoutAttribute {
    type: LayoutValueType;
    values?: string[];
    default?: string;
    lua?: LuaCallback;
    /** `@key` is looked up in the locales. */
    localizable?: boolean;
    /** Where the engine reads it: every element (`template`, `node`), containers, panels, or this element only. */
    group: "template" | "node" | "container" | "panel" | "element";
    description?: string;
    valueDescriptions?: Record<string, string>;
}

export interface LayoutElement {
    description?: string;
    /** Engine reader function in gui_xml.cpp. */
    reader: string;
    /** Only valid inside this element (`option`, `slot`, `slots-grid`). */
    parent?: string;
    content: {
        /** Inner text is read (`@key` is translated). */
        text: boolean;
        /** Child elements are read as UI nodes. */
        elements: boolean;
        /** Sub-elements only this element reads. */
        children?: string[];
    };
    attributes: Record<string, LayoutAttribute>;
}

export interface LayoutTypeDoc {
    description: string;
    examples: string[];
}

export const layoutElements = data.elements as unknown as Record<string, LayoutElement>;
export const layoutTypes = data.types as Record<"vec2" | "vec3" | "vec4" | "color", LayoutTypeDoc>;
export const layoutEnums = data.enums as Record<string, string[]>;

export function layoutElement(tag: string): LayoutElement | undefined {
    return Object.hasOwn(layoutElements, tag) ? layoutElements[tag] : undefined;
}

export function layoutAttribute(tag: string, name: string): LayoutAttribute | undefined {
    const element = layoutElement(tag);
    return element && Object.hasOwn(element.attributes, name) ? element.attributes[name] : undefined;
}

/** Tags that can appear at the top of a layout or inside any element that reads UI nodes. */
export function uiNodeTags(): string[] {
    return Object.keys(layoutElements).filter((tag) => !layoutElements[tag].parent);
}

/** Tags the engine reads inside `tag` (sub-elements first). */
export function childTags(tag: string): string[] {
    const element = layoutElement(tag);
    if (!element) return [];
    return [...(element.content.children ?? []), ...(element.content.elements ? uiNodeTags() : [])];
}
