// The ids a layout's script sees as `document.<id>` (UiDocument::read,
// UINode::getIndices): the root is always `root`; the first element with an id
// wins, and nothing inside a later duplicate is indexed; elements the engine
// doesn't read (falsy `if`, children of non-containers) don't exist.

import { layoutElement } from "./index";
import type { XmlElement, XmlNode } from "./xml";

function skipped(element: XmlElement): boolean {
    const falsy = (v: string) => v === "" || v === "false" || v === "nil";
    for (const a of element.attributes) {
        if (a.value.includes("%{")) continue;
        if (a.name === "if" && falsy(a.value)) return true;
        if (a.name === "ifnot" && !falsy(a.value)) return true;
    }
    return false;
}

export function documentIds(root: XmlNode | undefined): Map<string, XmlElement> {
    const ids = new Map<string, XmlElement>();
    if (!root || root.type !== "element" || skipped(root)) return ids;
    ids.set("root", root);
    const visit = (element: XmlElement) => {
        const info = layoutElement(element.tag);
        for (const child of element.children) {
            if (child.type !== "element") continue;
            const read = info?.content.elements || info?.content.children?.includes(child.tag);
            if (!read || skipped(child)) continue;
            const id = child.attributes.filter((a) => a.name === "id").pop()?.value;
            // `root` is set back to the root afterwards, but the element's subtree is indexed
            if (id && id !== "root" && !id.includes("%{")) {
                if (ids.has(id)) continue; // getIndices returns early: the subtree isn't indexed
                ids.set(id, child);
            }
            visit(child);
        }
    };
    visit(root);
    return ids;
}
