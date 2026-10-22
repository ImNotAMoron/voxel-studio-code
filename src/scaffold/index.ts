// Scaffolding commands: new project / pack / block / item / entity / component / layout.
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { pickPack, WorkspacePack } from "../packs";
import { CLIENT_SCRIPT, PERMISSIONS, PROJECT_FILE, START_SCRIPT } from "../../shared/content/project";
import * as t from "./templates";

export function registerScaffold(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("voxelcore.newProject", newProject),
        vscode.commands.registerCommand("voxelcore.newPack", newPack),
        vscode.commands.registerCommand("voxelcore.newBlock", (arg?: unknown) => newBlock(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newItem", (arg?: unknown) => newItem(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newEntity", (arg?: unknown) => newEntity(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newComponent", (arg?: unknown) => newComponent(hintUri(arg))),
        vscode.commands.registerCommand("voxelcore.newLayout", (arg?: unknown) => newLayout(hintUri(arg)))
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

async function newProject() {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let parent: vscode.Uri | undefined;
    if (folders.length === 1) {
        parent = folders[0].uri;
    } else {
        const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: "Create project here",
            defaultUri: folders[0]?.uri,
        });
        parent = picked?.[0];
    }
    if (!parent) return;
    const name = await vscode.window.showInputBox({
        title: "New project (1/3)",
        prompt: "Project name (project.toml `name`), also the folder name. Run it with --project <folder>.",
        placeHolder: "my_game",
        validateInput: (value) =>
            !/^[A-Za-z0-9_-]+$/.test(value) ? "letters, digits, '_' or '-'"
                : fs.existsSync(path.join(parent!.fsPath, value)) ? `folder '${value}' already exists` : undefined,
    });
    if (!name) return;
    const title = await vscode.window.showInputBox({
        title: "New project (2/3)",
        prompt: "Title (project.toml `title`)",
        value: t.idToCaption(name).replace(/\b\w/g, (c) => c.toUpperCase()),
    });
    if (title === undefined) return;
    const picked = await vscode.window.showQuickPick(
        PERMISSIONS.map((p) => ({ label: p.name, detail: `Allows ${p.doc.replace(/`/g, "")}` })),
        { title: "New project (3/3): permissions", placeHolder: "Select the permissions the project needs (none is fine)", canPickMany: true }
    );
    if (!picked) return;

    const root = vscode.Uri.joinPath(parent, name);
    const files: FileSet = new Map<string, string | Buffer>([
        [PROJECT_FILE, t.projectToml({ name, title, basePacks: ["base"], permissions: picked.map((p) => p.label) })],
        [CLIENT_SCRIPT, t.projectClientScript()],
        [START_SCRIPT, t.projectStartScript()],
    ]);
    const created = await writeFiles(root, files);
    for (const dir of ["content", "modules"]) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, dir));
    }
    await openCreated(created, vscode.Uri.joinPath(root, PROJECT_FILE));
}

async function newPack(arg?: unknown) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    // from a project node in the content explorer: into its content/ folder
    const projectRoot = (arg as { project?: { project?: { contentDir?: unknown } } } | undefined)?.project?.project?.contentDir;
    let parent: vscode.Uri | undefined;
    if (typeof projectRoot === "string") {
        parent = vscode.Uri.file(projectRoot);
        await vscode.workspace.fs.createDirectory(parent);
    } else if (folders.length === 1) {
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

async function newLayout(hint?: vscode.Uri) {
    const pack = await pickPack(hint, "Pack for the new layout");
    if (!pack) return;
    const name = await vscode.window.showInputBox({
        title: `New layout in ${pack.id}`,
        prompt: `Name: the layout id is ${pack.id}:<name>. A block's inventory layout is named like the block (or its ui-layout).`,
        validateInput: (value) =>
            t.validateUnitName(value) ??
            (fs.existsSync(path.join(pack.root.fsPath, "layouts", `${value}.xml`)) ? `layouts/${value}.xml already exists` : undefined),
    });
    if (!name) return;
    // a block with this name and an inventory opens this layout: offer that first
    const block = path.join(pack.root.fsPath, "blocks", `${name}.json`);
    const hasInventory = fs.existsSync(block) && /"inventory-size"\s*:\s*[1-9]/.test(fs.readFileSync(block, "utf8"));
    const kinds: { label: string; description: string; layoutKind: t.LayoutKind }[] = [
        { label: "Screen", description: "a centred panel with a title and a button", layoutKind: "screen" },
        { label: "Inventory", description: "a block's inventory (inventory-size > 0) with a slot grid", layoutKind: "inventory" },
        { label: "Empty", description: "an empty container", layoutKind: "empty" },
    ];
    if (hasInventory) kinds.unshift(kinds.splice(1, 1)[0]);
    const kind = await vscode.window.showQuickPick(kinds, { title: `Layout ${pack.id}:${name}` });
    if (!kind) return;
    const created = await writeFiles(pack.root, new Map([
        [`layouts/${name}.xml`, t.layoutXml(kind.layoutKind)],
        [`layouts/${name}.xml.lua`, t.layoutScript(kind.layoutKind)],
    ]));
    await openCreated(created, vscode.Uri.joinPath(pack.root, "layouts", `${name}.xml`));
}

