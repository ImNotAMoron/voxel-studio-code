// Block / entity / skeleton preview inputs (Node only, no vscode): finds the
// definition files of a unit and its `parent` chain with ContentIndex, loads
// model files by asset name, and runs the shared/models builders. The vscode
// glue (src/preview/index.ts) supplies live texts of open documents.

import * as fs from "node:fs";
import * as path from "node:path";

import { ContentIndex, normalizePath, type UnitDef, type UnitKind } from "../../shared/content";
import { buildModel, modelFormat, type ModelData, type ModelFormat } from "../../shared/models";
import type { ModelFile } from "../../shared/models/assets";
import { blockModelNames, buildBlockModel, finalizeBlock, loadBlockDef, type BlockDef } from "../../shared/models/block";
import { buildEntityModel, buildSkeletonModel, loadEntityDef, type EntityDef, type EntityHost } from "../../shared/models/entity";
import type { DefText } from "../../shared/models/jsondef";
import { findPackRoot } from "./textures";

export type PreviewKind = ModelFormat | "block" | "entity" | "skeleton";

/** Live text of a file (open editor) or undefined to read from disk. */
export type TextProvider = (file: string) => string | undefined;

const key = (file: string) => normalizePath(file).toLowerCase();

/** Kind of preview for a file, from its extension or its place in a pack. */
export function previewKind(file: string, resPath?: string): PreviewKind | undefined {
    const format = modelFormat(file);
    if (format) return format;
    if (!file.toLowerCase().endsWith(".json")) return undefined;
    const root = findPackRoot(file, resPath);
    if (!root) return undefined;
    const rel = path.relative(root, file).split(path.sep);
    if (rel.length < 2 || path.basename(file).startsWith("_")) return undefined;
    switch (rel[0]) {
        case "blocks":
            return "block";
        case "entities":
            return "entity";
        case "skeletons":
            return rel.length === 2 ? "skeleton" : undefined;
    }
    return undefined;
}

export interface PreviewBuild {
    model: ModelData;
    /** Files the preview depends on (definitions, skeletons, models). */
    dependencies: string[];
}

export class DefResolver {
    private deps = new Set<string>();

    constructor(
        readonly index: ContentIndex,
        private readonly liveText: TextProvider = () => undefined
    ) {}

    private read(file: string): string | undefined {
        this.deps.add(file);
        const live = this.liveText(file);
        if (live !== undefined) return live;
        try {
            return fs.readFileSync(file, "utf8");
        } catch {
            return undefined;
        }
    }

    private defText(file: string, main: string): DefText | undefined {
        const text = this.read(file);
        if (text === undefined) return undefined;
        return key(file) === key(main) ? { text } : { text, file };
    }

    private unitFor(kind: UnitKind, file: string): UnitDef | undefined {
        const k = key(file);
        const map = kind === "block" ? this.index.blocks : kind === "entity" ? this.index.entities : this.index.items;
        for (const unit of map.values()) {
            if (unit.file && key(unit.file) === k) return unit;
            if (unit.overrides.some((o) => key(o.file) === k)) return unit;
        }
        return undefined;
    }

    /** Id for a definition file that the index doesn't know (yet). */
    private fallbackId(file: string, folder: string): string {
        const pack = this.index.packForFile(file);
        const root = pack?.root ?? findPackRoot(file, this.index.resPath) ?? path.dirname(file);
        const rel = path.relative(path.join(root, folder), file).split(path.sep);
        const stem = path.basename(file, ".json");
        if (rel.length >= 2) return `${rel[rel.length - 2]}:${stem}`;
        return `${pack?.id ?? path.basename(root)}:${stem}`;
    }

    /** Definition files of a unit in engine load order (main, then overrides). */
    private unitFiles(unit: UnitDef | undefined, main: string): string[] {
        if (!unit) return [main];
        const files: string[] = [];
        if (unit.file) files.push(unit.file);
        for (const o of unit.overrides) files.push(o.file);
        if (!files.some((f) => key(f) === key(main))) files.push(main);
        return files;
    }

    private loadFiles(files: string[], main: string): DefText[] {
        return files.map((f) => this.defText(f, main)).filter((t): t is DefText => t !== undefined);
    }

    /** Finds a model file `models/<name>.{vec3,obj,vcm}` and builds it. */
    loadModel(name: string, fromPack?: string): ModelFile | undefined {
        // ContentIndex.resolveModel falls back to the name without `.suffix`;
        // the caller decides what the engine would do with that
        let file: string | undefined;
        let assetName = name;
        for (const pd of this.index.lookupOrder(fromPack)) {
            const found = pd.models.get(name);
            if (found) {
                file = found;
                break;
            }
        }
        if (!file && name.includes(".")) {
            assetName = name.slice(0, name.lastIndexOf("."));
            for (const pd of this.index.lookupOrder(fromPack)) {
                const found = pd.models.get(assetName);
                if (found) {
                    file = found;
                    break;
                }
            }
        }
        if (!file) return undefined;
        const format = modelFormat(file);
        if (!format) return undefined;
        this.deps.add(file);
        let content: string | Uint8Array;
        if (format === "vec3") {
            try {
                content = new Uint8Array(fs.readFileSync(file));
            } catch {
                return undefined;
            }
        } else {
            const text = this.read(file);
            if (text === undefined) return undefined;
            content = text;
        }
        return { assetName, format, data: buildModel(format, content), file };
    }

    // ---- blocks ----

    private blockById(id: string, main: string, depth: number): BlockDef | undefined {
        if (depth > 16) return undefined;
        const unit = this.index.blocks.get(id);
        if (!unit?.file) return undefined;
        return loadBlockDef(id, this.loadFiles(this.unitFiles(unit, unit.file), main), (p) => this.blockById(p, main, depth + 1));
    }

    buildBlock(file: string, options: { variant?: number; rotation?: number } = {}): PreviewBuild {
        this.deps = new Set([file]);
        const unit = this.unitFor("block", file);
        const id = unit?.id ?? this.fallbackId(file, "blocks");
        const raw = loadBlockDef(id, this.loadFiles(this.unitFiles(unit, file), file), (p) => this.blockById(p, file, 1));
        const def = finalizeBlock(raw);
        const pack = unit?.pack ?? this.index.packForFile(file)?.id;
        const models = new Map<string, ModelFile | undefined>();
        for (const name of blockModelNames(def)) models.set(name, this.loadModel(name, pack));
        const model = buildBlockModel(def, {
            ...options,
            loadModel: (name) => (models.has(name) ? models.get(name) : this.loadModel(name, pack)),
        });
        return { model, dependencies: [...this.deps] };
    }

    // ---- entities ----

    private entityById(id: string, main: string, depth: number): EntityDef | undefined {
        if (depth > 16) return undefined;
        const unit = this.index.entities.get(id);
        if (!unit?.file) return undefined;
        return loadEntityDef(id, this.loadFiles(this.unitFiles(unit, unit.file), main), (p) => this.entityById(p, main, depth + 1));
    }

    private entityHost(main: string, fromPack?: string): EntityHost {
        return {
            skeleton: (name) => {
                if (name.includes(":")) {
                    const file = this.index.resolveSkeleton(name);
                    if (!file) return undefined;
                    const source = this.defText(file, main);
                    return source ? { kind: "json", source } : undefined;
                }
                // a skeleton-name without ':' loads models/<name> (a VCM with bones)
                const model = this.loadModel(name, fromPack);
                return model && model.assetName === name ? { kind: "model", model } : undefined;
            },
            loadModel: (name) => {
                const model = this.loadModel(name, fromPack);
                return model && model.assetName === name ? model : undefined;
            },
            component: (name) => {
                const file = this.index.resolveComponent(name);
                if (file) this.deps.add(file);
                return file;
            },
        };
    }

    buildEntity(file: string): PreviewBuild {
        this.deps = new Set([file]);
        const unit = this.unitFor("entity", file);
        const id = unit?.id ?? this.fallbackId(file, "entities");
        const def = loadEntityDef(id, this.loadFiles(this.unitFiles(unit, file), file), (p) => this.entityById(p, file, 1));
        const pack = unit?.pack ?? this.index.packForFile(file)?.id;
        const model = buildEntityModel(def, this.entityHost(file, pack));
        return { model, dependencies: [...this.deps] };
    }

    buildSkeleton(file: string): PreviewBuild {
        this.deps = new Set([file]);
        const pack = this.index.packForFile(file);
        const name = `${pack?.id ?? "?"}:${path.basename(file, ".json")}`;
        const text = this.read(file) ?? "";
        const model = buildSkeletonModel(name, { text }, this.entityHost(file, pack?.id));
        return { model, dependencies: [...this.deps] };
    }

    build(kind: "block" | "entity" | "skeleton", file: string, options: { variant?: number; rotation?: number } = {}): PreviewBuild {
        switch (kind) {
            case "block":
                return this.buildBlock(file, options);
            case "entity":
                return this.buildEntity(file);
            case "skeleton":
                return this.buildSkeleton(file);
        }
    }
}
