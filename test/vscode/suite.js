// Runs inside a real VS Code extension host (see tools/vscode-smoke.mjs).
// Plain CJS so it needs no build step. Writes results to $VC_SMOKE_RESULT.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = await fn();
        if (value) return value;
        await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
}

exports.run = async function run() {
    const results = [];
    const check = async (name, fn) => {
        try {
            const detail = await fn();
            results.push({ name, ok: true, detail: detail ?? "" });
        } catch (err) {
            results.push({ name, ok: false, detail: String(err && err.message ? err.message : err) });
        }
    };
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;

    await check("extension activates", async () => {
        const ext = vscode.extensions.getExtension("voxelcore.voxelcore-tools");
        if (!ext) throw new Error("extension not found");
        await ext.activate();
        return `active=${ext.isActive}`;
    });

    await check("commands registered", async () => {
        const all = await vscode.commands.getCommands(true);
        const want = [
            "voxelcore.newPack", "voxelcore.newBlock", "voxelcore.openPreview",
            "voxelcore.runQuickWorld", "voxelcore.configureLua", "voxelcore.restartServer",
        ];
        const missing = want.filter((c) => !all.includes(c));
        if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
        return `${all.filter((c) => c.startsWith("voxelcore.")).length} voxelcore commands`;
    });

    await check("vcm/vca languages", async () => {
        const langs = await vscode.languages.getLanguages();
        if (!langs.includes("vcm") || !langs.includes("vca")) throw new Error("not registered");
        const doc = await vscode.workspace.openTextDocument(path.join(root, "smoke", "models", "stairs.vcm"));
        if (doc.languageId !== "vcm") throw new Error(`languageId=${doc.languageId}`);
        return "ok";
    });

    await check("linter + schema diagnostics on a broken block", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "blocks", "bad.json"));
        await vscode.window.showTextDocument(uri);
        const diags = await waitFor("diagnostics", () => {
            const d = vscode.languages.getDiagnostics(uri);
            const ours = d.filter((x) => x.source === "voxelcore");
            const schema = d.filter((x) => /emision/.test(x.message) && x.source !== "voxelcore");
            return ours.length && schema.length ? d : undefined;
        }, 60000);
        return diags.map((d) => `${d.source}:${typeof d.code === "object" ? d.code.value : d.code ?? ""} ${d.message}`).join(" | ");
    });

    await check("no errors/warnings on backrooms pack", async () => {
        await sleep(3000); // let the workspace lint finish
        const bad = vscode.languages
            .getDiagnostics()
            .filter(([u]) => u.fsPath.includes(`${path.sep}backrooms${path.sep}`))
            .flatMap(([u, d]) => d.filter((x) => x.severity <= vscode.DiagnosticSeverity.Warning).map((x) => `${path.basename(u.fsPath)}: ${x.message}`));
        if (bad.length) throw new Error(bad.join(" | "));
        return "clean";
    });

    await check("model preview opens", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "models", "stairs.vcm"));
        await vscode.window.showTextDocument(uri);
        await vscode.commands.executeCommand("voxelcore.openPreview", uri);
        const tab = await waitFor("preview tab", () =>
            vscode.window.tabGroups.all
                .flatMap((g) => g.tabs)
                .find((t) => t.input instanceof vscode.TabInputWebview && /modelPreview/.test(t.input.viewType))
        );
        return tab.label;
    });

    const previewInfo = (file, test) =>
        waitFor(`preview of ${path.basename(file)}`, async () => {
            const views = await vscode.commands.executeCommand("voxelcore.preview.inspect");
            const view = views.find((v) => vscode.Uri.parse(v.uri).fsPath === file);
            return view && test(view) ? view : undefined;
        });

    await check("block preview opens and updates live", async () => {
        const file = path.join(root, "smoke", "blocks", "stairs_block.json");
        const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
        await vscode.commands.executeCommand("voxelcore.openPreview", editor.document.uri);
        const first = await previewInfo(file, (v) => v.kind === "block" && v.triangles > 0 && v.rendered);
        if (first.errors.some((e) => e.startsWith("error"))) throw new Error(first.errors.join(" | "));
        if (first.rendered.error) throw new Error(`webview: ${first.rendered.error}`);
        if (first.rendered.triangles !== first.triangles) throw new Error(`webview drew ${first.rendered.triangles}△`);
        // live edit without saving: custom → aabb
        const text = editor.document.getText();
        const start = text.indexOf('"custom"');
        await editor.edit((e) =>
            e.replace(new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(start + 8)), '"aabb"')
        );
        const second = await previewInfo(
            file,
            (v) => v.info.some((l) => l.startsWith("model aabb")) && v.rendered && v.rendered.triangles === 12
        );
        if (second.rendered.labels !== 6) throw new Error(`${second.rendered.labels} face labels`);
        await vscode.commands.executeCommand("workbench.action.files.revert");
        return `${first.triangles}△ → ${second.triangles}△, webview: ${JSON.stringify(second.rendered)}`;
    });

    await check("entity preview opens with its skeleton", async () => {
        const file = path.join(root, "smoke", "entities", "bot.json");
        await vscode.window.showTextDocument(vscode.Uri.file(file));
        await vscode.commands.executeCommand("voxelcore.openPreview", vscode.Uri.file(file));
        const view = await previewInfo(file, (v) => v.kind === "entity" && v.parts.includes("head") && v.rendered);
        if (view.rendered.error) throw new Error(`webview: ${view.rendered.error}`);
        if (view.rendered.overlays !== 2 || view.rendered.triangles === 0) throw new Error(JSON.stringify(view.rendered));
        return `${view.parts.join(",")}, webview: ${JSON.stringify(view.rendered)}`;
    });

    await check("vec3 custom editor", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "models", "block.vec3"));
        await vscode.commands.executeCommand("vscode.openWith", uri, "voxelcore.vec3Preview");
        const tab = await waitFor("vec3 tab", () =>
            vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom)
        );
        return tab.label;
    });

    await check("voxelcore tasks provided", async () => {
        const tasks = await vscode.tasks.fetchTasks({ type: "voxelcore" });
        if (tasks.length < 2) throw new Error(`only ${tasks.length}`);
        return tasks.map((t) => t.name).join(", ");
    });

    await check("completion of texture names", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "blocks", "good.json"));
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const pos = doc.positionAt(text.indexOf('"stone_tex"') + 1);
        const list = await waitFor("completions", async () => {
            const l = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, pos);
            return l && l.items.some((i) => (i.label.label ?? i.label) === "stone_tex") ? l : undefined;
        });
        return `${list.items.length} items`;
    });

    fs.writeFileSync(process.env.VC_SMOKE_RESULT, JSON.stringify(results, null, 2));
};
