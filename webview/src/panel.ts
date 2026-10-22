// Side panel DOM: header, toggles, part (bone) visibility list, textures, and
// block / entity sections. Built with DOM APIs only (no innerHTML with
// styles) to keep the CSP strict.

import type { ModelData, ModelError, SourceRef } from "../../shared/models/types";
import type { PreviewOptions, PreviewToggles, TextureMap } from "../../shared/models/protocol";
import { placeholderColor } from "./placeholders";

const TOGGLE_LABELS: [keyof PreviewToggles, string][] = [
    ["wireframe", "Wireframe"],
    ["normals", "Normals"],
    ["culling", "Backface culling"],
    ["shading", "Shading"],
    ["grid", "Grid"],
    ["axes", "Axes"],
    ["block", "Unit block"],
    ["overlays", "Hitboxes / sensors"],
    ["labels", "Face labels"],
];

/** texture-faces order (Block.hpp FACE_MX..FACE_PZ). */
const FACE_NAMES = ["-X", "+X", "-Y", "+Y", "-Z", "+Z"];

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
    /** Block variant / rotation changed. */
    onOptions(options: PreviewOptions): void;
    /** Reveal a source range (face, component, bone). */
    onReveal(source: SourceRef): void;
    /** Highlight one part's geometry (undefined clears). */
    onHighlightPart(name: string | undefined): void;
}

export class Panel {
    private title = el("div", "title");
    private info = el("div", "info");
    private errors = el("div", "errors");
    private blockSection = el("section");
    private entitySection = el("section");
    private partsList = el("div", "list");
    private texturesList = el("div", "list");
    private hidden: Set<string>;
    private highlighted: string | undefined;

    constructor(
        root: HTMLElement,
        private toggles: PreviewToggles,
        hidden: string[],
        private callbacks: PanelCallbacks
    ) {
        this.hidden = new Set(hidden);
        root.append(this.title, this.info, this.errors, this.blockSection, this.entitySection);

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

    private link(text: string, source: SourceRef | undefined, className?: string): HTMLElement {
        const node = el("span", className, text);
        if (source) {
            node.classList.add("link");
            node.title = "Reveal in the definition";
            node.addEventListener("click", () => this.callbacks.onReveal(source));
        }
        return node;
    }

    private renderBlock(model: ModelData, textures: TextureMap) {
        const block = model.block;
        this.blockSection.replaceChildren();
        if (!block) return;
        this.blockSection.append(el("h3", undefined, "Block"));

        if (block.variantCount > 1) {
            const row = el("label", "row");
            const slider = el("input");
            slider.type = "range";
            slider.min = "0";
            slider.max = String(block.variantCount - 1);
            slider.value = String(block.variant);
            const value = el("span", undefined, `variant ${block.variant}${block.variant === 0 ? " (root)" : ""}`);
            slider.addEventListener("input", () => this.callbacks.onOptions({ variant: Number(slider.value) }));
            row.append(slider, value);
            this.blockSection.append(row);
        }
        if (block.rotationCount > 1) {
            const row = el("div", "row");
            const prev = el("button", "small", "◀");
            const next = el("button", "small", "▶");
            const label = el("span", undefined, `${block.profile} ${block.rotation + 1}/${block.rotationCount}`);
            prev.addEventListener("click", () => this.callbacks.onOptions({ rotation: (block.rotation + block.rotationCount - 1) % block.rotationCount }));
            next.addEventListener("click", () => this.callbacks.onOptions({ rotation: (block.rotation + 1) % block.rotationCount }));
            row.append(prev, next, label);
            this.blockSection.append(row);
        }

        const [r, g, b] = block.emission;
        if (r + g + b > 0) {
            const row = el("div", "row");
            const swatch = el("span", "swatch emission");
            const css = (v: number) => Math.round((v / 15) * 255);
            swatch.style.setProperty("--swatch", `rgb(${css(r)}, ${css(g)}, ${css(b)})`);
            row.append(swatch, el("span", undefined, `emission ${r}, ${g}, ${b}`));
            this.blockSection.append(row);
        }

        // texture-faces table: index, direction, texture; click reveals the value
        const faces = el("div", "list");
        for (let i = 0; i < 6; i++) {
            const name = block.textureFaces[i];
            const prim = model.primitives.find((p) => p.tag === "face" && p.side === i);
            const row = el("div", "row");
            const swatch = el("span", "swatch");
            const key = `blocks:${name}`;
            swatch.classList.add(textures[key] ? "found" : "missing");
            swatch.style.setProperty("--swatch", placeholderColor(key));
            row.append(
                el("span", "dim", `[${i}] ${FACE_NAMES[i]}`),
                swatch,
                this.link(name, prim ? { span: prim.span, ...(prim.file ? { file: prim.file } : {}) } : undefined)
            );
            faces.append(row);
        }
        this.blockSection.append(el("div", "dim", "texture-faces (unrotated)"), faces);

        const flags = el("div", "list");
        for (const flag of block.flags) {
            const row = el("div", "row");
            const value = typeof flag.value === "boolean" ? (flag.value ? "yes" : "no") : String(flag.value);
            row.append(el("span", "dim", flag.name), el("span", typeof flag.value === "boolean" && flag.value ? "on" : undefined, value));
            flags.append(row);
        }
        this.blockSection.append(flags);
        if (block.parents.length) this.blockSection.append(el("div", "dim", `parent: ${block.parents.join(" → ")}`));
    }

    private renderEntity(model: ModelData) {
        const entity = model.entity;
        this.entitySection.replaceChildren();
        if (!entity) return;
        this.entitySection.append(el("h3", undefined, entity.components.length || entity.bodyType ? "Entity" : "Skeleton"));
        const rows: [string, string][] = [["skeleton", `${entity.skeleton} (${entity.skeletonKind})`]];
        if (entity.bodyType) rows.push(["body-type", entity.bodyType]);
        if (entity.hitbox) rows.push(["hitbox", entity.hitbox.join(" × ")]);
        for (const [name, value] of rows) {
            const row = el("div", "row");
            row.append(el("span", "dim", name), el("span", entity.skeletonKind === "missing" && name === "skeleton" ? "error" : undefined, value));
            this.entitySection.append(row);
        }
        if (entity.components.length) {
            this.entitySection.append(el("div", "dim", "components"));
            for (const c of entity.components) {
                const row = el("div", "row");
                row.append(this.link(c.name, c.source, c.file ? undefined : "error"));
                if (!c.file) row.title = "scripts/components/<name>.lua not found";
                this.entitySection.append(row);
            }
        }
    }

    setModel(model: ModelData, textures: TextureMap, fileName: string) {
        this.title.textContent = fileName;
        this.info.replaceChildren(...model.info.map((line) => el("div", undefined, line)));
        this.setErrors(model.errors);
        this.renderBlock(model, textures);
        this.renderEntity(model);

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
            const name = el("span", "link", part.name || "(model)");
            if (this.highlighted === part.name) name.classList.add("selected");
            name.title = "Highlight (click again to clear)";
            name.addEventListener("click", (e) => {
                e.preventDefault();
                this.highlighted = this.highlighted === part.name ? undefined : part.name;
                for (const other of this.partsList.querySelectorAll(".selected")) other.classList.remove("selected");
                if (this.highlighted !== undefined) name.classList.add("selected");
                this.callbacks.onHighlightPart(this.highlighted);
                const bone = model.bones.find((b) => b.index === part.bone);
                if (this.highlighted !== undefined && bone?.span) this.callbacks.onReveal({ span: bone.span, ...(bone.file ? { file: bone.file } : {}) });
            });
            const bone = model.bones.find((b) => b.index === part.bone);
            const offset = bone && model.kind === "entity" ? ` @(${bone.origin.map((v) => Math.round(v * 1000) / 1000).join(", ")})` : "";
            row.append(input, indent, name, el("span", "dim", ` ${triangles}△${offset}`));
            rows.push(row);
        }
        // bones without geometry (entity skeletons) are listed dimmed
        if (model.kind === "entity") {
            for (const bone of model.bones) {
                if (model.parts.some((p) => p.bone === bone.index)) continue;
                const row = el("div", "row");
                row.append(el("span", `indent-${Math.min(depth.get(bone.index) ?? 0, 8)}`), this.link(bone.name || `#${bone.index}`, bone.span ? { span: bone.span, ...(bone.file ? { file: bone.file } : {}) } : undefined, "dim"));
                rows.push(row);
            }
        }
        if (this.highlighted !== undefined && !model.parts.some((p) => p.name === this.highlighted)) {
            this.highlighted = undefined;
            this.callbacks.onHighlightPart(undefined);
        }
        this.partsList.replaceChildren(...rows);

        const names = new Set<string>();
        for (const part of model.parts) for (const mesh of part.meshes) names.add(mesh.texture);
        const textureRows = [...names].sort().map((name) => {
            const row = el("div", "row");
            const swatch = el("span", "swatch");
            const found = Boolean(textures[name]);
            swatch.title = found ? textures[name].slice(0, 200) : name.startsWith("$") ? "texture slot (set by the block)" : "not found";
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
