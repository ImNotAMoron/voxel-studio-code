// Asset hovers (FEATURES.md §3.9) and translation hovers (§3.6): markdown
// with scaled texture thumbnails (data URIs), sound variants, model facts.

import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex } from "../../../shared/content/index";
import { translations } from "../../../shared/content/locale";
import { formatDuration, oggDuration, wavDuration } from "../../../shared/assets/audio";
import { COLOR_TYPE_NAMES, thumbnail } from "../../../shared/assets/png";
import { FACE_NAMES } from "../../../shared/models/block";
import { buildModel, modelFormat, vertexCount } from "../../../shared/models";

/** Client-side commands the hover links to (src/extension.ts trusts exactly these). */
export const OPEN_FILE_COMMAND = "voxelcore.openFile";
export const PREVIEW_FILE_COMMAND = "voxelcore.previewFile";

export function commandLink(title: string, command: string, file: string): string {
    return `[${title}](command:${command}?${encodeURIComponent(JSON.stringify([file]))})`;
}

const thumbs = new Map<string, { stamp: string; md: string }>();

/** A thumbnail image + one line of facts, cached by mtime. */
export function textureMarkdown(file: string, size = 128): string {
    let st: fs.Stats;
    try {
        st = fs.statSync(file);
    } catch {
        return "";
    }
    const key = `${file}|${size}`;
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = thumbs.get(key);
    if (hit?.stamp === stamp) return hit.md;
    let md = "";
    try {
        const t = thumbnail(fs.readFileSync(file), size);
        if (t) {
            const { width, height, colorType, bitDepth } = t.header;
            const alpha = { opaque: "opaque", cutout: "cut-out (alpha 0 or 255)", translucent: "translucent pixels" }[t.alpha];
            md = `![${path.basename(file)}](${t.dataUri})\n\n${width}×${height} · ${COLOR_TYPE_NAMES[colorType] ?? "?"}${bitDepth !== 8 ? ` ${bitDepth}-bit` : ""} · ${alpha}`;
        }
    } catch {
        md = "";
    }
    thumbs.set(key, { stamp, md });
    return md;
}

/** Animated block textures: `textures/<atlas>/<name>.json` next to the PNG. */
function animationNote(index: ContentIndex, file: string): string {
    const pack = index.packForFile(file);
    if (!pack) return "";
    const key = path.relative(path.join(pack.root, "textures"), file).split(path.sep).join("/").replace(/\.png$/i, "");
    const anim = index.getPackData(pack.id)?.textureAnimations.get(key);
    if (!anim) return "";
    try {
        const frames = JSON.parse(fs.readFileSync(anim, "utf8")).frames;
        return ` · animated${Array.isArray(frames) ? ` (${frames.length} frames)` : ""}`;
    } catch {
        return " · animated";
    }
}

export function textureHover(index: ContentIndex, file: string): string {
    const md = textureMarkdown(file);
    return md ? `${md}${animationNote(index, file)}\n\n${commandLink("Open", OPEN_FILE_COMMAND, file)}` : "";
}

/** The 6 `texture-faces` in the engine's order (Block.hpp FACE_MX…FACE_PZ). */
export function textureFacesHover(files: (string | undefined)[], names: string[]): string {
    const header = `| ${FACE_NAMES.map((n, i) => `${i}: ${n}`).join(" | ")} |`;
    const sep = `|${FACE_NAMES.map(() => ":-:").join("|")}|`;
    const cells = files.map((f, i) => {
        if (!f) return `*${names[i] ?? "?"}* not found`;
        const thumb = /!\[[^\]]*\]\(([^)]+)\)/.exec(textureMarkdown(f, 48))?.[1];
        return thumb ? `![${names[i]}](${thumb})` : names[i];
    });
    const labels = `| ${names.map((n) => `\`${n}\``).join(" | ")} |`;
    return [header, sep, `| ${cells.join(" | ")} |`, labels].join("\n");
}

const durations = new Map<string, { stamp: string; seconds?: number }>();

function duration(file: string): number | undefined {
    try {
        const st = fs.statSync(file);
        const stamp = `${st.mtimeMs}:${st.size}`;
        const hit = durations.get(file);
        if (hit?.stamp === stamp) return hit.seconds;
        const buf = fs.readFileSync(file);
        const seconds = file.toLowerCase().endsWith(".wav") ? wavDuration(buf) : oggDuration(buf);
        durations.set(file, { stamp, seconds });
        return seconds;
    } catch {
        return undefined;
    }
}

/** Variant files of a sound (`name.ogg`, `name_0.ogg`, `name_1.ogg`…) in the resolved pack. */
export function soundHover(index: ContentIndex, name: string, resolved: string): string {
    const pack = index.packForFile(resolved);
    const sounds = pack ? index.getPackData(pack.id)?.sounds : undefined;
    const files = sounds
        ? [...sounds].filter(([key]) => key === name || new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_\\d+$`).test(key)).map(([, f]) => f)
        : [resolved];
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const rows = files.map((f) => `- ${commandLink(`▶ ${path.basename(f)}`, OPEN_FILE_COMMAND, f)} · ${formatDuration(duration(f))}`);
    return `${files.length} variant${files.length === 1 ? "" : "s"} (the engine picks one at random)\n\n${rows.join("\n")}`;
}

const modelInfo = new Map<string, { stamp: string; md: string }>();

export function modelHover(file: string): string {
    const format = modelFormat(file);
    let md = "";
    try {
        const st = fs.statSync(file);
        const stamp = `${st.mtimeMs}:${st.size}`;
        const hit = modelInfo.get(file);
        if (hit?.stamp === stamp) return hit.md;
        if (format) {
            const content = format === "vec3" ? fs.readFileSync(file) : fs.readFileSync(file, "utf8");
            const model = buildModel(format, content);
            const min = [Infinity, Infinity, Infinity];
            const max = [-Infinity, -Infinity, -Infinity];
            const textures = new Set<string>();
            for (const part of model.parts) {
                for (const mesh of part.meshes) {
                    textures.add(mesh.texture);
                    for (let i = 0; i < mesh.positions.length; i++) {
                        min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
                        max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
                    }
                }
            }
            const triangles = vertexCount(model) / 3;
            const size = triangles ? max.map((v, i) => +(v - min[i]).toFixed(3)).join(" × ") : "empty";
            md = `${format.toUpperCase()} · ${triangles} triangles · size ${size}` +
                (textures.size ? `\n\ntextures: ${[...textures].slice(0, 8).map((t) => `\`${t}\``).join(", ")}` : "") +
                (model.errors.length ? `\n\n⚠ ${model.errors.length} error(s): ${model.errors[0].message}` : "");
        }
        md += `\n\n${commandLink("Open preview", PREVIEW_FILE_COMMAND, file)}`;
        modelInfo.set(file, { stamp, md });
    } catch {
        // unreadable model: just the link
        md = commandLink("Open preview", PREVIEW_FILE_COMMAND, file);
    }
    return md;
}

/** All translations of a caption / locale key, by language. */
export function translationsHover(index: ContentIndex, key: string, readText?: (file: string) => string | undefined): string {
    const found = translations(index, key, readText);
    if (!found.length) return `no translations of \`${key}\`: the engine shows the key itself`;
    // per language the last loaded wins (packs after res/texts)
    const byLang = new Map<string, (typeof found)[number]>();
    for (const t of found) byLang.set(t.lang, t);
    const rows = [...byLang.values()]
        .sort((a, b) => a.lang.localeCompare(b.lang))
        .map((t) => `| ${t.lang} | ${t.value.replace(/\|/g, "\\|") || "*(empty)*"} | ${t.pack} |`);
    return [`translations of \`${key}\``, "", "| language | text | pack |", "|---|---|---|", ...rows].join("\n");
}
