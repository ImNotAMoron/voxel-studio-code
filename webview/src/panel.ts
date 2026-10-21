// Side panel DOM: header, toggles, part (bone) visibility list, textures.
// Built with DOM APIs only (no innerHTML with styles) to keep the CSP strict.

import type { ModelData, ModelError } from "../../shared/models/types";
import type { PreviewToggles, TextureMap } from "../../shared/models/protocol";
import { placeholderColor } from "./placeholders";

const TOGGLE_LABELS: [keyof PreviewToggles, string][] = [
    ["wireframe", "Wireframe"],
    ["normals", "Normals"],
    ["culling", "Backface culling"],
    ["shading", "Shading"],
    ["grid", "Grid"],
    ["axes", "Axes"],
    ["block", "Unit block"],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export interface PanelCallbacks {
    onToggles(toggles: PreviewToggles): void;
    onHiddenParts(hidden: string[]): void;
    onFit(): void;
}

export class Panel {
    private title = el("div", "title");
    private info = el("div", "info");
    private errors = el("div", "errors");
    private partsList = el("div", "list");
    private texturesList = el("div", "list");
    private hidden: Set<string>;

    constructor(
        root: HTMLElement,
        private toggles: PreviewToggles,
        hidden: string[],
        private callbacks: PanelCallbacks
    ) {
        this.hidden = new Set(hidden);
        root.append(this.title, this.info, this.errors);

        const view = el("section");
        view.append(el("h3", undefined, "View"));
        for (const [key, label] of TOGGLE_LABELS) {
            const row = el("label", "row");
            const input = el("input");
            input.type = "checkbox";
            input.checked = this.toggles[key];
            input.addEventListener("change", () => {
                this.toggles = { ...this.toggles, [key]: input.checked };
                this.callbacks.onToggles(this.toggles);
            });
            row.append(input, el("span", undefined, label));
            view.append(row);
        }
        const fit = el("button", undefined, "Frame model");
        fit.addEventListener("click", () => this.callbacks.onFit());
        view.append(fit);

        const parts = el("section");
        parts.append(el("h3", undefined, "Parts / bones"), this.partsList);
        const textures = el("section");
        textures.append(el("h3", undefined, "Textures"), this.texturesList);
        root.append(view, parts, textures);
    }

    setModel(model: ModelData, textures: TextureMap, fileName: string) {
        this.title.textContent = fileName;
        this.info.replaceChildren(...model.info.map((line) => el("div", undefined, line)));
        this.setErrors(model.errors);

        const rows: HTMLElement[] = [];
        const depth = new Map<number, number>();
        for (const bone of model.bones) {
            depth.set(bone.index, bone.parent < 0 ? 0 : (depth.get(bone.parent) ?? 0) + 1);
        }
        for (const part of model.parts) {
            const row = el("label", "row");
            const input = el("input");
            input.type = "checkbox";
            input.checked = !this.hidden.has(part.name);
            input.addEventListener("change", () => {
                if (input.checked) this.hidden.delete(part.name);
                else this.hidden.add(part.name);
                this.callbacks.onHiddenParts([...this.hidden]);
            });
            const triangles = part.meshes.reduce((sum, m) => sum + m.positions.length / 9, 0);
            const indent = el("span", `indent-${Math.min(depth.get(part.bone) ?? 0, 8)}`);
            row.append(input, indent, el("span", undefined, part.name || "(model)"), el("span", "dim", ` ${triangles}△`));
            rows.push(row);
        }
        this.partsList.replaceChildren(...rows);

        const names = new Set<string>();
        for (const part of model.parts) for (const mesh of part.meshes) names.add(mesh.texture);
        const textureRows = [...names].sort().map((name) => {
            const row = el("div", "row");
            const swatch = el("span", "swatch");
            const found = Boolean(textures[name]);
            swatch.title = found ? textures[name] : name.startsWith("$") ? "texture slot (set by the block)" : "not found";
            const colorClass = found ? "found" : name.startsWith("$") ? "slot" : "missing";
            swatch.classList.add(colorClass);
            // placeholder color as a CSS custom property (CSSOM, CSP-safe)
            swatch.style.setProperty("--swatch", placeholderColor(name));
            row.append(swatch, el("span", found ? undefined : "dim", name));
            return row;
        });
        this.texturesList.replaceChildren(...textureRows);
    }

    setErrors(errors: ModelError[]) {
        this.errors.replaceChildren(
            ...errors.slice(0, 20).map((e) => el("div", e.severity === "error" ? "error" : "warning", e.message))
        );
    }
}
