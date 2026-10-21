// Finding content packs and the engine from the extension host.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePackManifest } from "./packs.manifest";

export interface WorkspacePack {
    id: string;
    title?: string;
    root: vscode.Uri;
    dependencies: string[];
}

const EXCLUDE = "{**/node_modules/**,**/.git/**,**/build/**,**/dist/**,**/.voxelcore/**}";

export { parsePackManifest };

export async function findWorkspacePacks(): Promise<WorkspacePack[]> {
    const files = await vscode.workspace.findFiles("**/package.json", EXCLUDE, 500);
    const packs: WorkspacePack[] = [];
    for (const file of files) {
        const bytes = await vscode.workspace.fs.readFile(file);
        const info = parsePackManifest(Buffer.from(bytes).toString("utf8"));
        if (!info) continue;
        // the engine's own res/ is the implicit core pack, not a workspace pack
        if (isEngineRes(path.dirname(file.fsPath))) continue;
        packs.push({ ...info, root: vscode.Uri.file(path.dirname(file.fsPath)) });
    }
    packs.sort((a, b) => a.id.localeCompare(b.id));
    return packs;
}

/** Packs inside `<res>/content` are built-in (base, ...). */
export function isBuiltinPack(pack: WorkspacePack, resPath: string | undefined): boolean {
    if (!resPath) return false;
    const rel = path.relative(path.join(resPath, "content"), pack.root.fsPath);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isEngineRes(dir: string): boolean {
    return fs.existsSync(path.join(dir, "content", "base", "package.json"));
}

/** Nearest ancestor of `uri` that is a pack root. */
export function packRootOf(uri: vscode.Uri): vscode.Uri | undefined {
    let dir = fs.existsSync(uri.fsPath) && fs.statSync(uri.fsPath).isDirectory()
        ? uri.fsPath
        : path.dirname(uri.fsPath);
    while (true) {
        const manifest = path.join(dir, "package.json");
        if (fs.existsSync(manifest) && parsePackManifest(fs.readFileSync(manifest, "utf8"))) {
            return vscode.Uri.file(dir);
        }
        const parent = path.dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** Engine `res/`: setting, else a workspace folder / ancestor containing res/content/base. */
export function findResPath(): string | undefined {
    const configured = vscode.workspace.getConfiguration("voxelcore").get<string>("resPath");
    if (configured) return resolveVariables(configured);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        let dir = folder.uri.fsPath;
        while (true) {
            if (isEngineRes(path.join(dir, "res"))) return path.join(dir, "res");
            if (isEngineRes(dir)) return dir;
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    const exe = findExecutable();
    if (exe) {
        const candidate = path.join(path.dirname(exe), "res");
        if (isEngineRes(candidate)) return candidate;
    }
    return undefined;
}

/** VoxelCore executable: setting, else build output next to a detected repo. */
export function findExecutable(): string | undefined {
    const configured = vscode.workspace.getConfiguration("voxelcore").get<string>("executable");
    if (configured) return resolveVariables(configured);
    const exeName = process.platform === "win32" ? "VoxelCore.exe" : "VoxelCore";
    const candidates: string[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        let dir = folder.uri.fsPath;
        while (true) {
            for (const sub of ["build/Release", "build/RelWithDebInfo", "build/Debug", "build", "."]) {
                candidates.push(path.join(dir, sub, exeName));
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    return candidates.find((c) => fs.existsSync(c));
}

export function resolveVariables(value: string): string {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    return value
        .replace(/\$\{workspaceFolder\}/g, folder)
        .replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~");
}

/** Pick a pack: the one containing `hint`, the only one, or ask. */
export async function pickPack(hint?: vscode.Uri, placeHolder = "Select a content pack"): Promise<WorkspacePack | undefined> {
    const packs = await findWorkspacePacks();
    const hinted = hint ?? vscode.window.activeTextEditor?.document.uri;
    if (hinted) {
        const root = packRootOf(hinted);
        const pack = root && packs.find((p) => p.root.fsPath === root.fsPath);
        if (pack) return pack;
    }
    if (packs.length === 1) return packs[0];
    if (packs.length === 0) {
        const create = "Create Content Pack";
        const answer = await vscode.window.showWarningMessage("No content packs found in the workspace.", create);
        if (answer === create) await vscode.commands.executeCommand("voxelcore.newPack");
        return undefined;
    }
    const item = await vscode.window.showQuickPick(
        packs.map((p) => ({ label: p.id, description: p.title, detail: vscode.workspace.asRelativePath(p.root), pack: p })),
        { placeHolder }
    );
    return item?.pack;
}
