// three.js scene for the model preview.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";

import type { ModelData, ModelMesh, ModelOverlays, ModelPrimitive, OverlayKind, Span } from "../../shared/models/types";
import type { PreviewToggles, TextureMap } from "../../shared/models/protocol";
import { configureTexture, createPlaceholderTexture } from "./placeholders";

/** ModelBatch::SUN_VECTOR and its shading formula (0.8 + dot * 0.2). */
const SUN = new THREE.Vector3(0.411934, 0.863868, -0.279161);
/** BlocksRenderer::SUN_VECTOR, DIRECTIONAL_LIGHT_FACTOR 0.3 (0.7 + dot * 0.3). */
const BLOCK_SUN = new THREE.Vector3(0.528265, 0.833149, -0.163704);

const OVERLAY_COLORS: Record<OverlayKind, number> = {
    hitbox: 0x33ddff,
    size: 0xffee55,
    cell: 0x777777,
    sensor: 0x66ff66,
    "entity-hitbox": 0xff66cc,
};

/** Text sprite (canvas texture) for face labels. */
function labelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const font = "bold 28px sans-serif";
    let width = 256;
    if (ctx) {
        ctx.font = font;
        width = Math.ceil(ctx.measureText(text).width) + 16;
    }
    canvas.width = width;
    canvas.height = 40;
    if (ctx) {
        ctx.font = font;
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(0, 0, width, 40);
        ctx.fillStyle = "#ffffff";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 8, 21);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    const height = 0.07;
    sprite.scale.set((height * width) / 40, height, 1);
    sprite.renderOrder = 20;
    return sprite;
}

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
    /** Hitboxes, sensors, size, cells (toggle "overlays"). */
    private shapesRoot = new THREE.Group();
    /** Face labels and arrows (toggle "labels"). */
    private labelsRoot = new THREE.Group();
    private partHighlight: string | undefined;
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
        this.scene.add(this.grid, this.axes, this.block, this.modelRoot, this.overlayRoot, this.helpersRoot, this.shapesRoot, this.labelsRoot);

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
        this.shapesRoot.visible = this.toggles.overlays;
        this.labelsRoot.visible = this.toggles.labels;
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
        // translucent blocks are alpha blended, everything else alpha tested
        const translucent = data.translucent === true;
        return new THREE.MeshBasicMaterial({
            map,
            vertexColors: true,
            wireframe: this.toggles.wireframe,
            side: this.toggles.culling ? THREE.FrontSide : THREE.DoubleSide,
            alphaTest: translucent ? 0 : 0.1,
            transparent: translucent,
            depthWrite: !translucent,
        });
    }

    /** Engine-like directional shading baked into vertex colors. */
    private shadeColors(data: ModelMesh): Float32Array {
        const count = data.positions.length / 3;
        const colors = new Float32Array(count * 3);
        const n = new THREE.Vector3();
        const block = this.model?.shadingModel === "block";
        const tint = data.tint ?? 1;
        for (let i = 0; i < count; i++) {
            let d = 1;
            if (data.shading && this.toggles.shading) {
                n.set(data.normals[i * 3], data.normals[i * 3 + 1], data.normals[i * 3 + 2]);
                d = block ? 0.7 + n.normalize().dot(BLOCK_SUN) * 0.3 : 0.8 + n.dot(SUN) * 0.2;
            }
            d *= tint;
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
        this.rebuildOverlays(model.overlays);
        this.requestFrame();
    }

    private disposeGroup(group: THREE.Group) {
        group.traverse((obj) => {
            const o = obj as THREE.Mesh;
            o.geometry?.dispose();
            const material = o.material as THREE.Material | THREE.Material[] | undefined;
            for (const m of Array.isArray(material) ? material : material ? [material] : []) {
                (m as THREE.SpriteMaterial).map?.dispose();
                m.dispose();
            }
        });
        group.clear();
    }

    /** Wireframe boxes / spheres and face labels from ModelData.overlays. */
    private rebuildOverlays(overlays: ModelOverlays | undefined) {
        this.disposeGroup(this.shapesRoot);
        this.disposeGroup(this.labelsRoot);
        if (!overlays) return;
        for (const box of overlays.boxes) {
            const size = new THREE.Vector3(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
            const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(Math.max(size.x, 1e-4), Math.max(size.y, 1e-4), Math.max(size.z, 1e-4)));
            const color = OVERLAY_COLORS[box.kind];
            const material =
                box.kind === "size"
                    ? new THREE.LineDashedMaterial({ color, dashSize: 0.08, gapSize: 0.05, depthTest: false, transparent: true })
                    : new THREE.LineBasicMaterial({ color, depthTest: box.kind === "cell", transparent: true, opacity: box.kind === "cell" ? 0.5 : 0.9 });
            const lines = new THREE.LineSegments(geometry, material);
            if (box.kind === "size") lines.computeLineDistances();
            lines.position.set((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
            lines.renderOrder = 15;
            this.shapesRoot.add(lines);
        }
        for (const sphere of overlays.spheres) {
            const geometry = new THREE.WireframeGeometry(new THREE.SphereGeometry(sphere.radius, 16, 8));
            const lines = new THREE.LineSegments(
                geometry,
                new THREE.LineBasicMaterial({ color: OVERLAY_COLORS[sphere.kind], transparent: true, opacity: 0.35, depthTest: false })
            );
            lines.position.set(...sphere.center);
            lines.renderOrder = 15;
            this.shapesRoot.add(lines);
        }
        for (const label of overlays.labels) {
            const origin = new THREE.Vector3(...label.position);
            const dir = new THREE.Vector3(...label.normal).normalize();
            const arrow = new THREE.ArrowHelper(dir, origin, 0.25, 0xff8844, 0.06, 0.04);
            arrow.renderOrder = 18;
            this.labelsRoot.add(arrow);
            const sprite = labelSprite(label.text);
            sprite.position.copy(origin).addScaledVector(dir, 0.32);
            this.labelsRoot.add(sprite);
        }
    }

    /** Counts of what the scene shows (reported to the host). */
    stats(): { meshes: number; triangles: number; overlays: number; labels: number } {
        let triangles = 0;
        for (const entry of this.entries) triangles += entry.data.positions.length / 9;
        return {
            meshes: this.entries.length,
            triangles,
            overlays: this.shapesRoot.children.length,
            labels: this.labelsRoot.children.filter((c) => c instanceof THREE.Sprite).length,
        };
    }

    /** Highlights all geometry of one part (bone); undefined clears. */
    highlightPart(name: string | undefined) {
        this.partHighlight = name;
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
        if (!model) return;
        const part = this.partHighlight;
        if (this.highlight.length === 0 && part === undefined) return;
        const flags = model.primitives.map((p) => this.isHighlighted(p));
        if (!flags.some((f) => f) && part === undefined) return;
        for (const entry of this.entries) {
            const ids = entry.data.primitiveIds;
            const src = entry.data.positions;
            const out: number[] = [];
            const whole = part !== undefined && entry.part === part;
            for (let t = 0; t < src.length / 9; t++) {
                if (whole || (ids[t] >= 0 && flags[ids[t]])) {
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
        if (this.toggles.overlays) box.union(new THREE.Box3().setFromObject(this.shapesRoot));
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
