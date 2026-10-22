// Model preview webview entry (bundled to dist/webview.js as an IIFE).

import type { HostToWebview, PreviewState, PreviewToggles, WebviewToHost } from "../../shared/models/protocol";
import { DEFAULT_TOGGLES } from "../../shared/models/protocol";
import { Panel } from "./panel";
import { Viewer } from "./viewer";

interface VsCodeApi {
    postMessage(message: WebviewToHost): void;
    getState(): PreviewState | undefined;
    setState(state: PreviewState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
let state: PreviewState = vscode.getState() ?? {};
const toggles: PreviewToggles = { ...DEFAULT_TOGGLES, ...state.toggles };

const viewport = document.getElementById("viewport") ?? document.body;
const sidebar = document.getElementById("sidebar") ?? document.body;

const viewer = new Viewer(viewport, toggles);
if (state.camera) {
    viewer.setCamera(state.camera);
}
viewer.setHiddenParts(state.hiddenParts ?? []);

function saveState(patch: Partial<PreviewState>) {
    state = { ...state, ...patch };
    vscode.setState(state);
}

let cameraTimer: ReturnType<typeof setTimeout> | undefined;
viewer.controls.addEventListener("change", () => {
    clearTimeout(cameraTimer);
    cameraTimer = setTimeout(() => saveState({ camera: viewer.getCamera() }), 200);
});

const panel = new Panel(sidebar, toggles, state.hiddenParts ?? [], {
    onToggles(next) {
        viewer.setToggles(next);
        saveState({ toggles: next });
    },
    onHiddenParts(hidden) {
        viewer.setHiddenParts(hidden);
        saveState({ hiddenParts: hidden });
    },
    onFit() {
        viewer.fit();
    },
    onOptions(options) {
        saveState({ options: { ...state.options, ...options } });
        vscode.postMessage({ type: "options", options });
    },
    onReveal(source) {
        vscode.postMessage({ type: "select", span: source.span, ...(source.file ? { file: source.file } : {}) });
    },
    onHighlightPart(name) {
        viewer.highlightPart(name);
    },
});

// click (without dragging) selects the primitive's source range
let down: { x: number; y: number } | undefined;
const canvas = viewer.renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : undefined;
});
canvas.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    down = undefined;
    const prim = viewer.pick(e.clientX, e.clientY);
    if (prim) {
        vscode.postMessage({ type: "select", span: prim.span, ...(prim.file ? { file: prim.file } : {}) });
    }
});

let firstModel = !state.camera;
window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    switch (message.type) {
        case "model":
            try {
                viewer.setModel(message.model, message.textures, message.textureVersion ?? 0);
                panel.setModel(message.model, message.textures, message.fileName);
                vscode.postMessage({ type: "rendered", stats: viewer.stats() });
            } catch (err) {
                const error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
                vscode.postMessage({ type: "rendered", stats: { meshes: 0, triangles: 0, overlays: 0, labels: 0, error } });
                throw err;
            }
            if (message.documentUri && message.documentUri !== state.uri) {
                saveState({ uri: message.documentUri });
            }
            if (firstModel) {
                firstModel = false;
                viewer.fit();
            }
            break;
        case "highlight":
            viewer.setHighlight(message.spans);
            break;
        case "error":
            panel.setErrors(message.errors);
            break;
    }
});

vscode.postMessage({ type: "ready", ...(state.options ? { options: state.options } : {}) });
