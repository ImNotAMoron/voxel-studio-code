// project.toml rules (Project::deserialize, ContentControl::resetContent).

import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { PERMISSION_NAMES, closest, isInside } from "../../../shared/content/index";
import { FileContext } from "./context";
import { reportTomlError } from "./pack";
import { TomlLocator } from "./toml";

export function lintProject(ctx: FileContext) {
    const { index, report, text } = ctx;
    let value: Record<string, unknown>;
    try {
        value = parseToml(text) as Record<string, unknown>;
    } catch (err) {
        // Engine::loadProject reads it before anything else: the engine doesn't start
        reportTomlError(ctx, err);
        return;
    }
    const loc = new TomlLocator(text);
    const project = index.projectFile(ctx.file)?.project;

    if (Array.isArray(value.permissions)) {
        for (const perm of value.permissions) {
            if (typeof perm !== "string" || PERMISSION_NAMES.has(perm)) continue;
            const token = loc.strings("", perm)[0];
            const suggestion = closest(perm, PERMISSION_NAMES);
            report.add("VC0500", token?.start ?? 0, token?.end ?? 0,
                `unknown permission '${perm}' (accepted and ignored by the engine)` +
                (suggestion ? `. Did you mean '${suggestion}'?` : `; known: ${[...PERMISSION_NAMES].join(", ")}`),
                { data: suggestion ? { suggestion } : undefined });
        }
    }

    if (Array.isArray(value.base_packs) && project) {
        const resContent = index.resPath ? path.join(index.resPath, "content") : undefined;
        for (const id of value.base_packs) {
            if (typeof id !== "string") continue;
            const token = loc.strings("", id)[0];
            const copies = id === "core" ? [] : [...index.packs.values(), ...index.shadowed].filter((p) => p.id === id);
            if (!copies.length) {
                report.add("VC0501", token?.start ?? 0, token?.end ?? 0,
                    `base pack '${id}' not found in ${path.basename(project.root)}/content or res/content: ` +
                    "the engine stops at start-up ('pack not found') unless the user content folder has it");
                continue;
            }
            const inSource = copies.some((p) => isInside(p.root, project.contentDir) || (resContent && isInside(p.root, resContent)));
            if (!inSource) {
                report.add("VC0502", token?.start ?? 0, token?.end ?? 0,
                    `base pack '${id}' is outside this project's content sources (${path.basename(project.root)}/content, ` +
                    "res/content): the engine finds it only if it's in the user content folder too", { severity: "hint" });
            }
        }
    }
}
