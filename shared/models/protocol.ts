// Messages between the preview controller (extension host) and the webview.

import type { ModelData, ModelError, Span } from "./types";

/** Texture name (as used by meshes) → webview URI; missing = placeholder. */
export type TextureMap = Record<string, string>;

export interface ModelMessage {
    type: "model";
    model: ModelData;
    textures: TextureMap;
    fileName: string;
    /** Source document URI; the webview stores it for panel restore. */
    documentUri?: string;
    /** Bumped when only texture files changed, so the webview reloads images. */
    textureVersion?: number;
}

export interface HighlightMessage {
    type: "highlight";
    /** Source spans of the elements under the cursor(s); empty clears. */
    spans: Span[];
}

export interface ErrorMessage {
    type: "error";
    errors: ModelError[];
}

export type HostToWebview = ModelMessage | HighlightMessage | ErrorMessage;

export interface ReadyMessage {
    type: "ready";
    /** Block variant / rotation restored from PreviewState. */
    options?: PreviewOptions;
}

export interface SelectMessage {
    type: "select";
    /** Span of the clicked primitive's element. */
    span: Span;
    /** Absolute path of the span's file when it isn't the previewed document. */
    file?: string;
}

/** Block variant / rotation picked in the webview; the host rebuilds. */
export interface OptionsMessage {
    type: "options";
    options: PreviewOptions;
}

export interface PreviewOptions {
    variant?: number;
    rotation?: number;
}

/** What the webview built for the last model (tests and diagnostics). */
export interface RenderedMessage {
    type: "rendered";
    stats: RenderStats;
}

export interface RenderStats {
    meshes: number;
    triangles: number;
    overlays: number;
    labels: number;
    /** Runtime error while building the scene, if any. */
    error?: string;
}

export type WebviewToHost = ReadyMessage | SelectMessage | OptionsMessage | RenderedMessage;

/** Persisted with `acquireVsCodeApi().setState` (also used by the serializer). */
export interface PreviewState {
    /** Document URI string (for WebviewPanelSerializer restore). */
    uri?: string;
    camera?: { position: [number, number, number]; target: [number, number, number] };
    toggles?: Partial<PreviewToggles>;
    hiddenParts?: string[];
    options?: PreviewOptions;
}

export interface PreviewToggles {
    wireframe: boolean;
    normals: boolean;
    culling: boolean;
    shading: boolean;
    grid: boolean;
    axes: boolean;
    block: boolean;
    /** Hitboxes, sensors, extended-block size and cells. */
    overlays: boolean;
    /** Block face labels and normal arrows. */
    labels: boolean;
}

export const DEFAULT_TOGGLES: PreviewToggles = {
    wireframe: false,
    normals: false,
    culling: true,
    shading: true,
    grid: true,
    axes: true,
    block: false,
    overlays: true,
    labels: true,
};
