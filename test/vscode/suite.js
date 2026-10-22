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

    await check("content explorer views", async () => {
        await vscode.commands.executeCommand("workbench.view.extension.voxelcore");
        const info = await waitFor("explorer data", async () => {
            const i = await vscode.commands.executeCommand("voxelcore.explorer.inspect");
            return i && i.packs.smoke && i.packs.backrooms ? i : undefined;
        });
        if (!(info.packs.smoke.blocks >= 3)) throw new Error(JSON.stringify(info.packs.smoke));
        if (info.dependencies < 2) throw new Error(`dependencies view: ${info.dependencies} packs`);
        if (!info.engine.some((r) => r.startsWith("Resources: ") && !r.includes("not found"))) throw new Error(info.engine.join(" | "));
        return `smoke ${JSON.stringify(info.packs.smoke)}; ${info.engine.join(" | ")}`;
    });

    await check("engine log mapped to Problems", async () => {
        const world = path.join(root, "smoke", "scripts", "world.lua");
        const uri = vscode.Uri.file(world);
        const runtime = () => vscode.languages.getDiagnostics(uri).filter((d) => d.source === "VoxelCore engine");
        // synthetic log line: resolution and the diagnostic collection
        await vscode.commands.executeCommand(
            "voxelcore.log.feed",
            '[E] 2026/10/22 11:02:03.350+0300 [           lua-debug] error in event (smoke:.worldopen) handler: [string "core:modules/internal/debugging.lua"]:149: fed\n' +
                "stack traceback:\n" +
                '\t[string "smoke:scripts/world.lua"]:2: in function <[string "smoke:scripts/world.lua"]:1>\n'
        );
        const fed = runtime();
        if (fed.length !== 1 || fed[0].range.start.line !== 1 || fed[0].message !== "fed") {
            throw new Error(`fed: ${JSON.stringify(fed.map((d) => [d.range.start.line, d.message]))}`);
        }
        const settings = vscode.workspace.getConfiguration("voxelcore");
        if (!settings.get("executable")) return "fed log ok; engine run skipped (no build/Debug executable)";
        // a real headless run through the voxelcore task
        const script = path.join(root, "smoke_app.lua");
        const ended = new Promise((resolve) => {
            const sub = vscode.tasks.onDidEndTask((e) => {
                if (e.execution.task.definition.action === "headless") {
                    sub.dispose();
                    resolve();
                }
            });
        });
        await vscode.commands.executeCommand("voxelcore.runHeadlessScript", vscode.Uri.file(script));
        const diags = await waitFor("engine diagnostics", () => {
            const d = runtime();
            return d.some((x) => x.message === "smoke world error") ? d : undefined;
        }, 90000);
        await Promise.race([ended, sleep(30000)]);
        return diags.map((d) => `${path.basename(world)}:${d.range.start.line + 1} ${d.message}`).join(" | ");
    });

    await check("asset hovers, gutter thumbnails, locale files", async () => {
        const goodUri = vscode.Uri.file(path.join(root, "smoke", "blocks", "good.json"));
        const goodDoc = await vscode.workspace.openTextDocument(goodUri);
        await vscode.window.showTextDocument(goodDoc);
        const at = goodDoc.positionAt(goodDoc.getText().indexOf("stone_tex") + 2);
        const hovers = await waitFor("texture hover", async () => {
            const h = await vscode.commands.executeCommand("vscode.executeHoverProvider", goodUri, at);
            return h && h.some((x) => x.contents.some((c) => /data:image\/png;base64/.test(c.value))) ? h : undefined;
        });
        const md = hovers.flatMap((h) => h.contents).find((c) => /data:image/.test(c.value));
        if (!md.isTrusted || !md.isTrusted.enabledCommands.includes("voxelcore.openFile")) throw new Error(`hover not trusted: ${JSON.stringify(md.isTrusted)}`);
        const gutter = await waitFor("gutter icons", async () => {
            const g = await vscode.commands.executeCommand("voxelcore.thumbnails.inspect", goodUri);
            return g && g.length && g[0].icon && fs.existsSync(g[0].icon) ? g : undefined;
        });
        const localeUri = vscode.Uri.file(path.join(root, "smoke", "texts", "ru_RU.txt"));
        const localeDoc = await vscode.workspace.openTextDocument(localeUri);
        await vscode.window.showTextDocument(localeDoc);
        if (localeDoc.languageId !== "vclang") throw new Error(`languageId=${localeDoc.languageId}`);
        const diags = await waitFor("VC0304", () => {
            const d = vscode.languages.getDiagnostics(localeUri).filter((x) => x.code && x.code.value === "VC0304");
            return d.length ? d : undefined;
        }, 30000);
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", localeUri);
        if (!symbols || symbols[0].name !== "smoke") throw new Error(`outline: ${JSON.stringify(symbols)}`);
        return `hover image + trusted links, ${gutter.length} gutter icon(s), ${diags[0].message.slice(0, 80)}`;
    });

    await check("debugger stops at a breakpoint", async () => {
        if (!vscode.workspace.getConfiguration("voxelcore").get("executable")) return "skipped (no build/Debug executable)";
        const script = path.join(root, "dbg_app.lua");
        const uri = vscode.Uri.file(script);
        const events = [];
        const tracker = vscode.debug.registerDebugAdapterTrackerFactory("voxelcore", {
            createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => m.type === "event" && events.push(m) }),
        });
        vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(2, 0)))]);
        try {
            const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
                type: "voxelcore", request: "launch", name: "smoke debug", mode: "headless", script,
            });
            if (!started) throw new Error("startDebugging returned false");
            const stopped = await waitFor("stopped event", () => events.find((e) => e.event === "stopped"), 60000);
            const session = vscode.debug.activeDebugSession;
            const { stackFrames } = await session.customRequest("stackTrace", { threadId: 1 });
            const top = stackFrames[0];
            if (top.line !== 3 || top.source.path.toLowerCase() !== script.toLowerCase()) throw new Error(JSON.stringify(top));
            const { scopes } = await session.customRequest("scopes", { frameId: top.id });
            const { variables } = await session.customRequest("variables", { variablesReference: scopes[0].variablesReference });
            const names = variables.map((v) => v.name).join(",");
            if (names !== "n,t") throw new Error(`locals ${names}`);
            const ended = new Promise((resolve) => {
                const sub = vscode.debug.onDidTerminateDebugSession(() => {
                    sub.dispose();
                    resolve();
                });
            });
            await vscode.debug.stopDebugging(session);
            await Promise.race([ended, sleep(15000)]);
            return `${stopped.body.reason} at ${path.basename(top.source.path)}:${top.line} in ${top.name}, locals ${names}`;
        } finally {
            tracker.dispose();
            vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        }
    });

    await check("references, code lens and rename", async () => {
        const refsUri = vscode.Uri.file(path.join(root, "smoke", "scripts", "refs.lua"));
        const refsDoc = await vscode.workspace.openTextDocument(refsUri);
        const at = refsDoc.positionAt(refsDoc.getText().indexOf("smoke:good") + 7);
        const locations = await waitFor("references", async () => {
            const l = await vscode.commands.executeCommand("vscode.executeReferenceProvider", refsUri, at);
            return l && l.length >= 2 ? l : undefined;
        });
        const files = locations.map((l) => path.basename(l.uri.fsPath)).sort();
        if (!files.includes("good.json") || !files.includes("refs.lua")) throw new Error(files.join(", "));
        const goodUri = vscode.Uri.file(path.join(root, "smoke", "blocks", "good.json"));
        const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", goodUri);
        const lens = lenses.find((l) => l.command && /reference/.test(l.command.title));
        if (!lens || lens.command.title !== "1 reference") throw new Error(`lens: ${lens && lens.command.title}`);

        // F2 on a texture: the edit renames the PNG; VS Code also runs willRenameFiles for it,
        // which must not rewrite the references a second time
        const goodDoc = await vscode.workspace.openTextDocument(goodUri);
        const texAt = goodDoc.positionAt(goodDoc.getText().indexOf("stone_tex") + 2);
        const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", goodUri, texAt, "rock_tex");
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error("rename edit not applied");
        const textures = path.join(root, "smoke", "textures", "blocks");
        if (!fs.existsSync(path.join(textures, "rock_tex.png"))) throw new Error("rock_tex.png not created");
        const stairs = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, "smoke", "blocks", "stairs_block.json")));
        const count = (text, word) => text.split(`"${word}"`).length - 1;
        if (count(goodDoc.getText(), "rock_tex") !== 1 || count(stairs.getText(), "rock_tex") !== 6) {
            throw new Error(`after F2: ${goodDoc.getText()} | ${stairs.getText()}`);
        }

        // a file rename (as from the Explorer) updates references through willRenameFiles
        const move = new vscode.WorkspaceEdit();
        move.renameFile(vscode.Uri.file(path.join(textures, "rock_tex.png")), vscode.Uri.file(path.join(textures, "pebble.png")));
        if (!(await vscode.workspace.applyEdit(move))) throw new Error("file rename not applied");
        await waitFor("pebble in good.json", () => count(goodDoc.getText(), "pebble") === 1, 10000);
        if (count(stairs.getText(), "pebble") !== 6) throw new Error(`after file rename: ${stairs.getText()}`);
        await vscode.workspace.saveAll(false);
        return `${locations.length} references, lens "${lens.command.title}", F2 + Explorer rename ok`;
    });

    fs.writeFileSync(process.env.VC_SMOKE_RESULT, JSON.stringify(results, null, 2));
};
