import * as path from "node:path";
import { ContentIndex } from "../../shared/content/index";
import { createEnv, lintPack, lintProjectFiles, collectMentions } from "../../server/src/linter";
import { VcDiagnostic } from "../../server/src/rules/report";

export const EXT_ROOT = path.resolve(__dirname, "..", "..");
export const REPO_ROOT = path.resolve(EXT_ROOT, "..");
export const RES = path.join(REPO_ROOT, "res");
export const BASE = path.join(RES, "content", "base");
export const BACKROOMS = path.join(REPO_ROOT, "packs", "backrooms");
export const FIXTURES = path.join(__dirname, "fixtures");
export const GOODPACK = path.join(FIXTURES, "goodpack");
export const ERRPACK = path.join(FIXTURES, "errpack");

/** Lints pack folders like the CLI does (unknown keys included). */
export function lintDirs(dirs: string[], options: { editor?: boolean } = {}): { index: ContentIndex; diagnostics: VcDiagnostic[] } {
    const index = new ContentIndex({ resPath: RES, packDirs: dirs });
    const env = createEnv(index, { unknownKeys: !options.editor }, !!options.editor);
    const mentions = collectMentions(index);
    const diagnostics: VcDiagnostic[] = [];
    for (const pack of [...index.packs.values(), ...index.shadowed]) {
        if (!dirs.some((d) => path.resolve(d) === pack.root)) continue;
        for (const list of lintPack(env, pack, undefined, mentions).values()) diagnostics.push(...list);
    }
    return { index, diagnostics };
}

export function rel(file: string): string {
    return path.relative(FIXTURES, file).split(path.sep).join("/");
}

export function describe(d: VcDiagnostic): string {
    return `${path.relative(REPO_ROOT, d.file)} ${d.severity} ${d.code} ${d.message}`;
}

/** Lints a project folder like the CLI does: its project files and the packs in its content/. */
export function lintProjectDir(dir: string, packDirs: string[] = []): { index: ContentIndex; diagnostics: VcDiagnostic[] } {
    const index = new ContentIndex({ resPath: RES, roots: [dir], packDirs });
    const env = createEnv(index, { unknownKeys: true }, false);
    const mentions = collectMentions(index);
    const diagnostics: VcDiagnostic[] = [];
    for (const pack of index.lintablePacks()) {
        if (!pack.root.startsWith(path.resolve(dir))) continue;
        for (const list of lintPack(env, pack, undefined, mentions).values()) diagnostics.push(...list);
    }
    for (const project of index.lintableProjects()) {
        for (const list of lintProjectFiles(env, project).values()) diagnostics.push(...list);
    }
    return { index, diagnostics };
}
