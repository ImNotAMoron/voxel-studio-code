// Generated placeholder textures for `$N` slots and missing images.

import * as THREE from "three";

const PALETTE = ["#d9534f", "#5cb85c", "#428bca", "#f0ad4e", "#9b59b6", "#1abc9c", "#e67e22", "#7f8c8d"];

function hash(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
        h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

/** Color used for a texture name; `$N` slots get stable distinct colors. */
export function placeholderColor(name: string): string {
    const slot = /^\$(\d+)$/.exec(name);
    return PALETTE[(slot ? Number(slot[1]) : hash(name)) % PALETTE.length];
}

/**
 * A 64×64 checker with the texture name written on it. Canvas textures keep
 * three's default flipY, like images, so the label reads upright where the
 * engine would show the top of the image.
 */
export function createPlaceholderTexture(name: string, missing: boolean): THREE.Texture {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
        const color = placeholderColor(name);
        const cells = 4;
        const cell = size / cells;
        for (let y = 0; y < cells; y++) {
            for (let x = 0; x < cells; x++) {
                ctx.fillStyle = (x + y) % 2 === 0 ? color : missing ? "#202020" : "#ffffff";
                ctx.globalAlpha = (x + y) % 2 === 0 ? 1 : 0.85;
                ctx.fillRect(x * cell, y * cell, cell, cell);
            }
        }
        ctx.globalAlpha = 1;
        // top-left marker shows the texture orientation
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, 6, 6);
        const label = name.length > 10 ? name.slice(name.lastIndexOf(":") + 1).slice(0, 10) : name;
        ctx.font = `bold ${label.length > 4 ? 12 : 20}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000000";
        ctx.strokeText(label, size / 2, size / 2);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, size / 2, size / 2);
        if (missing) {
            ctx.strokeStyle = "#ff00ff";
            ctx.lineWidth = 2;
            ctx.strokeRect(1, 1, size - 2, size - 2);
        }
    }
    const texture = new THREE.CanvasTexture(canvas);
    configureTexture(texture);
    return texture;
}

/** Engine-like sampling: nearest, no mipmaps, sRGB. */
export function configureTexture(texture: THREE.Texture): void {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    // png.cpp stores the bottom image row first, so engine v = 0 is the image
    // bottom; WebGL's UNPACK_FLIP_Y (three's default flipY = true) does the same.
    texture.flipY = true;
    texture.needsUpdate = true;
}
