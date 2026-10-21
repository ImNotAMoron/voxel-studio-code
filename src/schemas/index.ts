// Workspace schema settings the static jsonValidation contribution can't
// express (see associations.ts). Written to workspace settings only with the
// same consent as the Lua configuration (`voxelcore.configureLua`).
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { findResPath, findWorkspacePacks, isBuiltinPack } from "../packs";
import { CatalogEntry, JsonSchemaSetting, packRootJsonSchemas, sameJson, tomlAssociations } from "./associations";

const TOML_EXTENSION_ID = "tamasfe.even-better-toml";
const LUA_CHOICE_STATE = "voxelcore.lua.choice";

let extensionContext: vscode.ExtensionContext;

export function registerSchemas(context: vscode.ExtensionContext): void {
    extensionContext = context;
    context.subscriptions.push(
        vscode.extensions.onDidChange(() => void applySchemaSettings(false)),
        vscode.workspace.onDidCreateFiles((e) => {
            if (e.files.some((f) => f.path.endsWith("/package.json"))) void applySchemaSettings(false);
        })
    );
    void applySchemaSettings(false).catch((err) => console.error("voxelcore: schema settings failed", err));
}

function hasConsent(): boolean {
    const mode = vscode.workspace.getConfiguration("voxelcore").get<string>("configureLua", "ask");
    if (mode === "never") return false;
    return mode === "always" || extensionContext.workspaceState.get<string>(LUA_CHOICE_STATE) === "configured";
}

function schemaUrl(file: string): string {
    return vscode.Uri.joinPath(extensionContext.extensionUri, "schemas", file).toString();
}

function readCatalog(): CatalogEntry[] {
    const file = path.join(extensionContext.extensionPath, "schemas", "catalog.json");
    return JSON.parse(fs.readFileSync(file, "utf8")) as CatalogEntry[];
}

/** Applies TOML associations and pack-root json.schemas. `force` skips the consent check. */
export async function applySchemaSettings(force: boolean): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !extensionContext) return;
    if (!force && !hasConsent()) return;
    const resPath = findResPath();
    const packs = (await findWorkspacePacks()).filter((p) => !isBuiltinPack(p, resPath));
    if (packs.length === 0) return;
    const catalog = readCatalog();

    if (vscode.extensions.getExtension(TOML_EXTENSION_ID)) {
        const config = vscode.workspace.getConfiguration("evenBetterToml");
        const current = config.inspect<Record<string, string>>("schema.associations")?.workspaceValue ?? {};
        const next = tomlAssociations(catalog, schemaUrl, current);
        if (!sameJson(current, next)) {
            await config.update("schema.associations", next, vscode.ConfigurationTarget.Workspace);
        }
    }

    // packs inside a `content/` folder are already covered by jsonValidation
    const roots = packs
        .filter((p) => path.basename(path.dirname(p.root.fsPath)) !== "content")
        .filter((p) => vscode.workspace.getWorkspaceFolder(p.root)?.uri.toString() === folder.uri.toString())
        .map((p) => path.relative(folder.uri.fsPath, p.root.fsPath).split(path.sep).join("/"));
    const json = vscode.workspace.getConfiguration("json");
    const currentSchemas = json.inspect<JsonSchemaSetting[]>("schemas")?.workspaceValue ?? [];
    const nextSchemas = packRootJsonSchemas(roots, schemaUrl, currentSchemas);
    if (!sameJson(currentSchemas, nextSchemas)) {
        await json.update("schemas", nextSchemas, vscode.ConfigurationTarget.Workspace);
    }
}
