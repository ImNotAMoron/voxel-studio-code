// Scaffolding commands: new pack / block / item / entity / component.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { pickPack, WorkspacePack } from "../packs";
import * as t from "./templates";

export function registerScaffold(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("voxelcore.newPack", newPack),
        vscode.commands.registerCommand("voxelcore.newBlock", (arg?: unknown) => newBlock(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newItem", (arg?: unknown) => newItem(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newEntity", (arg?: unknown) => newEntity(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newComponent", (arg?: unknown) => newComponent(hintUri(arg)))
    );
}

/** A file explorer Uri, or a content explorer pack node (`{ pack: { root } }`). */
function hintUri(arg: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) return arg;
    const root = (arg as { pack?: { root?: unknown } } | undefined)?.pack?.root;
    return typeof root === "string" ? vscode.Uri.file(root) : undefined;
}

/** Files to create; existing files are never overwritten. */
type FileSet = Map<string, string | Buffer>;

async function writeFiles(root: vscode.Uri, files: FileSet): Promise<vscode.Uri[]> {
    const created: vscode.Uri[] = [];
    for (const [rel, content] of files) {
        const uri = vscode.Uri.joinPath(root, rel);
        if (fs.existsSync(uri.fsPath)) continue;
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        await vscode.workspace.fs.writeFile(uri, bytes);
        created.push(uri);
    }
    return created;
}

async function addCaption(pack: WorkspacePack, name: string) {
    const caption = t.idToCaption(name);
    const uri = vscode.Uri.joinPath(pack.root, "texts", "en_US.txt");
    const text = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, "utf8") : "";
    const updated = t.addLocaleEntry(text, caption, caption);
    if (updated !== text) await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, "utf8"));
}

async function askUnitName(kind: string, pack: WorkspacePack, folder: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
        title: `New ${kind} in ${pack.id}`,
        prompt: `Name (the full id will be ${pack.id}:<name>)`,
        validateInput: (value) => {
            const error = t.validateUnitName(value);
            if (error) return error;
            if (fs.existsSync(path.join(pack.root.fsPath, folder, `${value}.json`))) {
                return `${folder}/${value}.json already exists`;
            }
            return undefined;
        },
    });
}

function packHasBase(pack: WorkspacePack): boolean {
    return pack.dependencies.some((d) => d.replace(/^[!?~]/, "").split("@")[0] === "base");
}

async function openCreated(created: vscode.Uri[], main: vscode.Uri) {
    await vscode.window.showTextDocument(main);
    if (created.length > 1) {
        const names = created.map((u) => vscode.workspace.asRelativePath(u)).join(", ");
        vscode.window.setStatusBarMessage(`VoxelCore: created ${names}`, 8000);
    }
}

async function newPack() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let parent: vscode.Uri | undefined;
    if (folders.length === 1) {
        parent = folders[0].uri;
    } else {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "Create pack here",
            defaultUri: folders[0]?.uri,
        });
        parent = picked?.[0];
    }
    if (!parent) return;
    const id = await vscode.window.showInputBox({
        title: "New content pack (1/3)",
        prompt: "Pack id. Also used as the folder name and the prefix of every content id.",
        placeHolder: "my_pack",
        validateInput: (value) =>
            t.validatePackId(value) ??
            (fs.existsSync(path.join(parent!.fsPath, value)) ? `folder '${value}' already exists` : undefined),
    });
    if (!id) return;
    const title = await vscode.window.showInputBox({
        title: "New content pack (2/3)",
        prompt: "Title shown in the content menu",
        value: t.idToCaption(id).replace(/\b\w/g, (c) => c.toUpperCase()),
    });
    if (title === undefined) return;
    const creator = await vscode.window.showInputBox({
        title: "New content pack (3/3)",
        prompt: "Creator",
        value: process.env.USERNAME ?? process.env.USER ?? "",
    });
    if (creator === undefined) return;

    const root = vscode.Uri.joinPath(parent, id);
    const files: FileSet = new Map<string, string | Buffer>([
        ["package.json", t.packageJson({ id, title, creator, description: "", dependencies: ["base"] })],
        ["icon.png", t.placeholderPng(id, 128)],
        ["texts/en_US.txt", "# captions: <caption>=<translation>\n"],
        ["scripts/world.lua", t.worldScript()],
    ]);
    const created = await writeFiles(root, files);
    for (const dir of ["blocks", "items", "entities", "models", "textures/blocks", "textures/items", "modules"]) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, dir));
    }
    await openCreated(created, vscode.Uri.joinPath(root, "package.json"));
    void vscode.commands.executeCommand("voxelcore.configureLua").then(undefined, () => undefined);
}

async function newBlock(hint?: vscode.Uri) {
    const pack = await pickPack(hint, "Pack for the new block");
    if (!pack) return;
    const name = await askUnitName("block", pack, "blocks");
    if (!name) return;
    const kinds: { label: string; description: string; blockKind: t.BlockKind }[] = [
        { label: "Basic", description: "one texture on all sides", blockKind: "basic" },
        { label: "Six faces", description: "texture-faces: side / bottom / top", blockKind: "faces" },
        { label: "Custom model", description: "models/<name>.vcm", blockKind: "model" },
        { label: "Light source", description: "emission + shadeless", blockKind: "light" },
    ];
    const kind = await vscode.window.showQuickPick(kinds, { title: `Block ${pack.id}:${name}` });
    if (!kind) return;
    const withScript = await vscode.window.showQuickPick(["No script", "With script (scripts/<name>.lua)"], {
        title: "Block script",
    });
    if (!withScript) return;

    const files: FileSet = new Map();
    files.set(`blocks/${name}.json`, t.blockJson(name, kind.blockKind, packHasBase(pack)));
    for (const texture of t.blockTextureNames(name, kind.blockKind)) {
        files.set(`textures/blocks/${texture}.png`, t.placeholderPng(texture));
    }
    if (kind.blockKind === "model") files.set(`models/${name}.vcm`, t.blockModelVcm(name));
    if (withScript.startsWith("With")) files.set(`scripts/${name}.lua`, t.blockScript());
    const created = await writeFiles(pack.root, files);
    await addCaption(pack, name);
    await openCreated(created, vscode.Uri.joinPath(pack.root, "blocks", `${name}.json`));
}

async function newItem(hint?: vscode.Uri) {
    const pack = await pickPack(hint, "Pack for the new item");
    if (!pack) return;
    const name = await askUnitName("item", pack, "items");
    if (!name) return;
    const files: FileSet = new Map<string, string | Buffer>([
        [`items/${name}.json`, t.itemJson(name)],
        [`textures/items/${name}.png`, t.placeholderPng(name)],
        [`scripts/${name}.lua`, t.itemScript()],
    ]);
    const created = await writeFiles(pack.root, files);
    await addCaption(pack, name);
    await openCreated(created, vscode.Uri.joinPath(pack.root, "items", `${name}.json`));
}

async function newEntity(hint?: vscode.Uri) {
    const pack = await pickPack(hint, "Pack for the new entity");
    if (!pack) return;
    const name = await askUnitName("entity", pack, "entities");
    if (!name) return;
    const files: FileSet = new Map([
        [`entities/${name}.json`, t.entityJson(pack.id, name)],
        [`scripts/components/${name}.lua`, t.componentScript()],
    ]);
    const created = await writeFiles(pack.root, files);
    await openCreated(created, vscode.Uri.joinPath(pack.root, "entities", `${name}.json`));
}

async function newComponent(hint?: vscode.Uri) {
    const pack = await pickPack(hint, "Pack for the new component");
    if (!pack) return;
    const name = await vscode.window.showInputBox({
        title: `New entity component in ${pack.id}`,
        prompt: `Name (referenced as "${pack.id}:<name>" in entity components)`,
        validateInput: (value) =>
            t.validateUnitName(value) ??
            (fs.existsSync(path.join(pack.root.fsPath, "scripts", "components", `${value}.lua`))
                ? "component already exists"
                : undefined),
    });
    if (!name) return;
    const created = await writeFiles(pack.root, new Map([[`scripts/components/${name}.lua`, t.componentScript()]]));
    await openCreated(created, vscode.Uri.joinPath(pack.root, "scripts", "components", `${name}.lua`));
}
