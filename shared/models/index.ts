// Entry point of the preview mesh builders (pure TS, no vscode / DOM).

import { buildObjModel } from "./obj";
import type { ModelData } from "./types";
import { buildVcmModelFromText } from "./vcm";
import { buildVec3Model } from "./vec3";

export * from "./types";
export { buildVcmModel, buildVcmModelFromText, SIDE_NAMES } from "./vcm";
export { buildObjModel } from "./obj";
export { buildVec3Model, loadVec3 } from "./vec3";

export type ModelFormat = "vcm" | "obj" | "vec3";

/** Format by file name, or undefined for unsupported files. */
export function modelFormat(fileName: string): ModelFormat | undefined {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".vcm")) return "vcm";
    if (lower.endsWith(".obj")) return "obj";
    if (lower.endsWith(".vec3")) return "vec3";
    return undefined;
}

/** Builds a model from text (vcm/obj) or bytes (vec3). */
export function buildModel(format: ModelFormat, content: string | Uint8Array): ModelData {
    switch (format) {
        case "vcm":
            return buildVcmModelFromText(typeof content === "string" ? content : new TextDecoder().decode(content));
        case "obj":
            return buildObjModel(typeof content === "string" ? content : new TextDecoder().decode(content));
        case "vec3":
            return buildVec3Model(typeof content === "string" ? new TextEncoder().encode(content) : content);
    }
}
