// three.js scene for the model preview.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";

import type { ModelData, ModelMesh, ModelPrimitive, Span } from "../../shared/models/types";
import type { PreviewToggles, TextureMap } from "../../shared/models/protocol";
import { configureTexture, createPlaceholderTexture } from "./placeholders";

/** ModelBatch::SUN_VECTOR and its shading formula (0.8 + dot * 0.2). */
const SUN = new THREE.Vector3(0.411934, 0.863868, -0.279161);

interface MeshEntry {
    mesh: THREE.Mesh;
    data: ModelMesh;
    part: string;
}

const spanContains = (outer: Span, inner: Span) => outer.start <= inner.start && inner.end <= outer.end;

export class Viewer {
    readonly renderer: THREE.WebGLRenderer;
    readonly scene = new THREE.Scene();
    readonly camera: THREE.PerspectiveCamera;
    readonly controls: OrbitControls;

    private modelRoot = new THREE.Group();
    private overlayRoot = new THREE.Group();
    private helpersRoot = new THREE.Group();
    private grid: THREE.GridHelper;
    private axes: THREE.AxesHelper;
    private block: THREE.LineSegments;
    private entries: MeshEntry[] = [];
    private parts = new Map<string, THREE.Group>();
    private textures = new Map<string, { uri: string | undefined; texture: THREE.Texture }>();
    private textureVersion = 0;
    private loader = new THREE.TextureLoader();
    private model: ModelData | undefined;
    private highlight: Span[] = [];
    private hidden = new Set<string>();
    private frameRequested = false;

    toggles: PreviewToggles;

    constructor(readonly container: HTMLElement, toggles: PreviewToggles) {
        this.toggles = { ...toggles };
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(this.renderer.domElement);

        this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
        this.camera.position.set(2.2, 1.8, 2.6);
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0.5, 0.5, 0.5);
        this.controls.enableDamping = false;
        this.controls.addEventListener("change", () => this.requestFrame());

        this.grid = new THREE.GridHelper(16, 16, 0x888888, 0x555555);
        (this.grid.material as THREE.Material).transparent = true;
        (this.grid.material as THREE.Material).opacity = 0.5;
        this.axes = new THREE.AxesHelper(1.5);
        this.axes.position.y = 0.001;
        const blockGeometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        this.block = new THREE.LineSegments(blockGeometry, new THREE.LineBasicMaterial({ color: 0xffff66 }));
        this.block.position.set(0.5, 0.5, 0.5); // block models use 0..1 coordinates
        this.scene.add(this.grid, this.axes, this.block, this.modelRoot, this.overlayRoot, this.helpersRoot);

        new ResizeObserver(() => this.resize()).observe(container);
        this.resize();
        this.applyToggles();
    }

    resize() {
        const width = Math.max(1, this.container.clientWidth);
        const height = Math.max(1, this.container.clientHeight);
        this.renderer.setSize(width, height, false);
        this.renderer.domElement.style.width = `${width}px`;
        this.renderer.domElement.style.height = `${height}px`;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.requestFrame();
    }

    requestFrame() {
        if (this.frameRequested) return;
        this.frameRequested = true;
        requestAnimationFrame(() => {
            this.frameRequested = false;
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        });
    }

    setHiddenParts(names: Iterable<string>) {
        this.hidden = new Set(names);
        for (const [name, group] of this.parts) {
            group.visible = !this.hidden.has(name);
        }
        this.rebuildHelpers();
        this.requestFrame();
    }

    setToggles(toggles: PreviewToggles) {
        this.toggles = { ...toggles };
        this.applyToggles();
    }

    private applyToggles() {
        this.grid.visible = this.toggles.grid;
        this.axes.visible = this.toggles.axes;
        this.block.visible = this.toggles.block;
        for (const entry of this.entries) {
            (entry.mesh.material as THREE.Material).dispose();
            entry.mesh.material = this.createMaterial(entry.data);
        }
        this.rebuildHelpers();
        this.requestFrame();
    }

    private texture(name: string, uri: string | undefined): THREE.Texture {
        const cached = this.textures.get(name);
        if (cached && cached.uri === uri) {
            return cached.texture;
        }
        cached?.texture.dispose();
        let texture: THREE.Texture;
        if (uri) {
            const url = this.textureVersion ? `${uri}${uri.includes("?") ? "&" : "?"}v=${this.textureVersion}` : uri;
            const loaded = this.loader.load(
                url,
                (image) => {
                    configureTexture(image);
                    this.requestFrame();
                },
                undefined,
                () => {
                    const entry = this.textures.get(name);
                    if (entry && entry.texture === loaded) {
                        entry.texture = createPlaceholderTexture(name, true);
                        this.applyToggles();
                    }
                }
            );
            configureTexture(loaded);
            texture = loaded;
        } else {
            texture = createPlaceholderTexture(name, !name.startsWith("$"));
        }
        this.textures.set(name, { uri, texture });
        return texture;
    }

    private textureMap: TextureMap = {};

    private createMaterial(data: ModelMesh): THREE.Material {
        const map = this.texture(data.texture, this.textureMap[data.texture]);
        return new THREE.MeshBasicMaterial({
            map,
            vertexColors: true,
            wireframe: this.toggles.wireframe,
            side: this.toggles.culling ? THREE.FrontSide : THREE.DoubleSide,
            alphaTest: 0.1,
            transparent: false,
        });
    }

    /** Engine-like directional shading baked into vertex colors. */
    private shadeColors(data: ModelMesh): Float32Array {
        const count = data.positions.length / 3;
        const colors = new Float32Array(count * 3);
        const n = new THREE.Vector3();
        for (let i = 0; i < count; i++) {
            let d = 1;
            if (data.shading && this.toggles.shading) {
                n.set(data.normals[i * 3], data.normals[i * 3 + 1], data.normals[i * 3 + 2]);
                d = 0.8 + n.dot(SUN) * 0.2;
            }
            colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = d;
        }
        return colors;
    }

    setModel(model: ModelData, textures: TextureMap, textureVersion = 0) {
        if (textureVersion !== this.textureVersion) {
            this.textureVersion = textureVersion;
            for (const entry of this.textures.values()) entry.texture.dispose();
            this.textures.clear();
        }
        this.textureMap = textures;
        this.model = model;
        for (const entry of this.entries) {
            entry.mesh.geometry.dispose();
            (entry.mesh.material as THREE.Material).dispose();
        }
        this.modelRoot.clear();
        this.entries = [];
        this.parts.clear();
        for (const part of model.parts) {
            const group = new THREE.Group();
            group.name = part.name;
            group.position.set(part.offset[0], part.offset[1], part.offset[2]);
            group.visible = !this.hidden.has(part.name);
            for (const data of part.meshes) {
                if (data.positions.length === 0) continue;
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
                geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
                geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3));
                geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.shadeColors(data), 3));
                geometry.computeBoundingSphere();
                const mesh = new THREE.Mesh(geometry, this.createMaterial(data));
                mesh.userData.primitiveIds = data.primitiveIds;
                group.add(mesh);
                this.entries.push({ mesh, data, part: part.name });
            }
            this.modelRoot.add(group);
            this.parts.set(part.name, group);
        }
        // drop textures no longer used
        const used = new Set(this.entries.map((e) => e.data.texture));
        for (const [name, entry] of this.textures) {
            if (!used.has(name)) {
                entry.texture.dispose();
                this.textures.delete(name);
            }
        }
        this.rebuildHelpers();
        this.rebuildHighlight();
        this.requestFrame();
    }

    private rebuildShading() {
        for (const entry of this.entries) {
            entry.mesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.shadeColors(entry.data), 3));
        }
    }

    private rebuildHelpers() {
        this.rebuildShading();
        for (const child of this.helpersRoot.children) {
            (child as VertexNormalsHelper).dispose?.();
        }
        this.helpersRoot.clear();
        if (!this.toggles.normals) return;
        this.modelRoot.updateMatrixWorld(true);
        for (const entry of this.entries) {
            if (this.hidden.has(entry.part)) continue;
            const helper = new VertexNormalsHelper(entry.mesh, 0.1, 0x00ccff);
            this.helpersRoot.add(helper);
        }
    }

    setHighlight(spans: Span[]) {
        this.highlight = spans;
        this.rebuildHighlight();
        this.requestFrame();
    }

    private isHighlighted(prim: ModelPrimitive | undefined): boolean {
        if (!prim) return false;
        for (const span of this.highlight) {
            if (spanContains(span, prim.span)) return true;
            if (prim.partSpans?.some((p) => spanContains(span, p))) return true;
        }
        return false;
    }

    private rebuildHighlight() {
        for (const child of this.overlayRoot.children) {
            const obj = child as THREE.Mesh | THREE.LineSegments;
            obj.geometry.dispose();
            (obj.material as THREE.Material).dispose();
        }
        this.overlayRoot.clear();
        const model = this.model;
        if (!model || this.highlight.length === 0) return;
        const flags = model.primitives.map((p) => this.isHighlighted(p));
        if (!flags.some((f) => f)) return;
        for (const entry of this.entries) {
            const ids = entry.data.primitiveIds;
            const src = entry.data.positions;
            const out: number[] = [];
            for (let t = 0; t < ids.length; t++) {
                if (ids[t] >= 0 && flags[ids[t]]) {
                    for (let k = 0; k < 9; k++) out.push(src[t * 9 + k]);
                }
            }
            if (out.length === 0) continue;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
            const fill = new THREE.Mesh(
                geometry,
                new THREE.MeshBasicMaterial({
                    color: 0xffaa00,
                    transparent: true,
                    opacity: 0.35,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                    polygonOffset: true,
                    polygonOffsetFactor: -1,
                    polygonOffsetUnits: -1,
                })
            );
            const edges = new THREE.LineSegments(
                new THREE.WireframeGeometry(geometry),
                new THREE.LineBasicMaterial({ color: 0xffdd55, depthTest: false, transparent: true, opacity: 0.9 })
            );
            const group = this.parts.get(entry.part);
            for (const obj of [fill, edges]) {
                if (group) obj.position.copy(group.position);
                obj.visible = !this.hidden.has(entry.part);
                obj.renderOrder = 10;
                this.overlayRoot.add(obj);
            }
        }
    }

    /** Primitive under a canvas point (client coordinates). */
    pick(clientX: number, clientY: number): ModelPrimitive | undefined {
        if (!this.model) return undefined;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1
        );
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(ndc, this.camera);
        const meshes = this.entries.filter((e) => !this.hidden.has(e.part)).map((e) => e.mesh);
        for (const hit of raycaster.intersectObjects(meshes, false)) {
            if (hit.faceIndex === undefined || hit.faceIndex === null) continue;
            const ids = hit.object.userData.primitiveIds as number[] | undefined;
            const id = ids?.[hit.faceIndex];
            if (id !== undefined && id >= 0) {
                return this.model.primitives[id];
            }
        }
        return undefined;
    }

    /** Frames the visible model. */
    fit() {
        const box = new THREE.Box3().setFromObject(this.modelRoot);
        if (box.isEmpty()) {
            box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 1));
        }
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(0.25, box.getSize(new THREE.Vector3()).length() * 0.5);
        const distance = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
        const direction = new THREE.Vector3(1, 0.8, 1.2).normalize();
        this.controls.target.copy(center);
        this.camera.position.copy(center).addScaledVector(direction, distance);
        this.camera.near = Math.max(0.001, distance / 1000);
        this.camera.far = distance * 100;
        this.camera.updateProjectionMatrix();
        this.requestFrame();
    }

    getCamera(): { position: [number, number, number]; target: [number, number, number] } {
        const p = this.camera.position;
        const t = this.controls.target;
        return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
    }

    setCamera(state: { position: [number, number, number]; target: [number, number, number] }) {
        this.camera.position.set(...state.position);
        this.controls.target.set(...state.target);
        this.requestFrame();
    }
}
