// Quick fixes.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    CodeAction, CodeActionKind, CreateFile, Diagnostic, TextDocumentEdit, TextEdit, WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { PNG } from "pngjs";
import { closest } from "../../../shared/content/index";
import { fileRole } from "../linter";
import { LintEnv } from "../rules/context";
import { callbacksFor, ScriptKind } from "../lua/spec";
import { DefKind } from "../schemas";
import { fileToUri } from "../uri";

export const CREATE_TEXTURE_COMMAND = "voxelcore.server.createTexture";

const ROLE_KIND: Record<string, DefKind> = {
    block: "block", item: "item", entity: "entity", material: "material", skeleton: "skeleton", package: "package", preload: "preload",
};

function createFileEdit(file: string, content: string): WorkspaceEdit {
    const uri = fileToUri(file);
    return {
        documentChanges: [
            CreateFile.create(uri, { ignoreIfExists: true }),
            TextDocumentEdit.create({ uri, version: null }, [TextEdit.insert({ line: 0, character: 0 }, content)]),
        ],
    };
}

function scriptTemplate(kind: ScriptKind, name: string): string {
    const callbacks = callbacksFor(kind) ?? [];
    const lines = [`-- ${name}`, ""];
    for (const cb of callbacks.slice(0, kind === "component" ? 2 : 1)) {
        lines.push(`function ${cb.name}(${cb.params.join(", ")})`, "end", "");
    }
    return lines.join("\n");
}

/** Writes a 16×16 placeholder texture (magenta/black checker). */
export function writePlaceholderTexture(file: string) {
    const png = new PNG({ width: 16, height: 16 });
    for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
            const i = (y * 16 + x) * 4;
            const on = ((x >> 3) + (y >> 3)) % 2 === 0;
            png.data[i] = on ? 255 : 0;
            png.data[i + 1] = 0;
            png.data[i + 2] = on ? 255 : 0;
            png.data[i + 3] = 255;
        }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, PNG.sync.write(png));
}

export function codeActions(env: LintEnv, doc: TextDocument, file: string, diagnostics: Diagnostic[]): CodeAction[] {
    const actions: CodeAction[] = [];
    const { pack, role } = fileRole(env.index, file);
    for (const diag of diagnostics) {
        const data = (diag.data ?? {}) as Record<string, unknown>;
        // VS Code JSON language service: `Property X is not allowed.`
        const message = typeof diag.message === "string" ? diag.message : (diag.message as { value: string }).value;
        const m = /^Property (.+) is not allowed\.?$/.exec(message);
        if (m && (diag.source === "json" || diag.source === undefined || diag.source === "")) {
            const kind = ROLE_KIND[role];
            if (!kind) continue;
            const name = m[1].replace(/^"|"$/g, "");
            if (name.includes(":")) continue;
            const suggestion = closest(name, env.schemas.knownKeys(kind));
            if (suggestion) {
                const original = doc.getText(diag.range);
                const quoted = original.startsWith('"') ? `"${suggestion}"` : suggestion;
                actions.push({
                    title: `Rename to '${suggestion}'`,
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diag],
                    isPreferred: true,
                    edit: { changes: { [doc.uri]: [TextEdit.replace(diag.range, quoted)] } },
                });
            }
            continue;
        }
        if (diag.source !== "voxelcore") continue;
        const code = typeof diag.code === "string" ? diag.code : "";
        if ((code === "VC0010" || code === "VC0101") && typeof data.suggestion === "string") {
            const original = doc.getText(diag.range);
            const replacement = original.startsWith('"') ? `"${data.suggestion}"` : data.suggestion;
            actions.push({
                title: `Rename to '${data.suggestion}'`,
                kind: CodeActionKind.QuickFix,
                diagnostics: [diag],
                isPreferred: true,
                edit: { changes: { [doc.uri]: [TextEdit.replace(diag.range, replacement)] } },
            });
        }
        if (code === "VC0011" && typeof data.prop === "string") {
            const target = env.index.packs.get(String(data.declarePack ?? pack?.id ?? ""));
            if (!target) continue;
            const propsFile = path.join(target.root, "config", "user-props.toml");
            const line = `"${data.prop}" = {}\n`;
            let edit: WorkspaceEdit;
            if (fs.existsSync(propsFile)) {
                const existing = fs.readFileSync(propsFile, "utf8");
                const lines = existing.split("\n");
                const lastLine = lines.length - 1;
                const needsNewline = existing.length > 0 && !existing.endsWith("\n");
                edit = {
                    changes: {
                        [fileToUri(propsFile)]: [TextEdit.insert({ line: lastLine, character: lines[lastLine].length }, (needsNewline ? "\n" : "") + line)],
                    },
                };
            } else {
                edit = createFileEdit(propsFile, line);
            }
            actions.push({
                title: `Declare '${data.prop}' in ${target.id}/config/user-props.toml`,
                kind: CodeActionKind.QuickFix,
                diagnostics: [diag],
                isPreferred: true,
                edit,
            });
        }
        const createTexture = data.createTexture as { atlas: string; name: string } | undefined;
        if (createTexture && pack) {
            const target = path.join(pack.root, "textures", createTexture.atlas, createTexture.name + ".png");
            actions.push({
                title: `Create placeholder texture ${pack.id}/textures/${createTexture.atlas}/${createTexture.name}.png`,
                kind: CodeActionKind.QuickFix,
                diagnostics: [diag],
                command: { title: "Create texture", command: CREATE_TEXTURE_COMMAND, arguments: [target] },
            });
        }
        const createScript = data.createScript as { pack: string; name: string; kind: ScriptKind } | undefined;
        if (createScript) {
            const target = env.index.packs.get(createScript.pack);
            if (target && !target.builtin) {
                const scriptFile = path.join(target.root, "scripts", ...createScript.name.split("/")) + ".lua";
                actions.push({
                    title: `Create ${target.id}/scripts/${createScript.name}.lua`,
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diag],
                    edit: createFileEdit(scriptFile, scriptTemplate(createScript.kind, createScript.name)),
                });
            }
        }
        const createModule = data.createModule as { pack: string; name: string } | undefined;
        if (createModule) {
            const target = env.index.packs.get(createModule.pack);
            if (target) {
                const moduleFile = path.join(target.root, "modules", ...createModule.name.split("/")) + ".lua";
                actions.push({
                    title: `Create module ${target.id}/modules/${createModule.name}.lua`,
                    kind: CodeActionKind.QuickFix,
                    diagnostics: [diag],
                    edit: createFileEdit(moduleFile, "local M = {}\n\nreturn M\n"),
                });
            }
        }
    }
    return actions;
}
