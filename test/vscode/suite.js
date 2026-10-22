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
            "voxelcore.newPack", "voxelcore.newBlock", "voxelcore.newLayout", "voxelcore.openPreview",
            "voxelcore.runQuickWorld", "voxelcore.configureLua", "voxelcore.restartServer",
            "voxelcore.newProject", "voxelcore.runProject",
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

    await check("projects: explorer node, project.toml and start.lua diagnostics", async () => {
        const info = await waitFor("project in the explorer", async () => {
            const i = await vscode.commands.executeCommand("voxelcore.explorer.inspect");
            return i && i.projects && i.projects.game ? i : undefined;
        });
        const rows = info.projects.game.join(" | ");
        if (!rows.includes("pack gamepack") || !rows.includes("Permissions: netwrk")) throw new Error(rows);
        const diagsOf = async (rel, code) => {
            const uri = vscode.Uri.file(path.join(root, "game", rel));
            await vscode.workspace.openTextDocument(uri);
            return waitFor(code, () => {
                const d = vscode.languages.getDiagnostics(uri).filter((x) => x.code && x.code.value === code);
                return d.length ? d : undefined;
            });
        };
        const perm = await diagsOf("project.toml", "VC0500");
        const call = await diagsOf("start.lua", "VC0503");
        const fixes = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", vscode.Uri.file(path.join(root, "game", "start.lua")), call[0].range);
        if (!fixes.some((a) => /Grant 'network'/.test(a.title))) throw new Error(`fixes: ${fixes.map((a) => a.title).join(", ")}`);
        return `${rows}; ${perm[0].message.slice(0, 50)}; ${call[0].message.slice(0, 50)}`;
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

    await check("XML layouts: diagnostics, completion, hover, outline, colours", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "layouts", "menu.xml"));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        if (doc.languageId !== "xml") throw new Error(`languageId=${doc.languageId}`);
        const diags = await waitFor("VC0402", () => {
            const d = vscode.languages.getDiagnostics(uri).filter((x) => x.code && x.code.value === "VC0402");
            return d.length ? d : undefined;
        }, 30000);
        // `<` on the empty line inside <panel>
        const edit = new vscode.WorkspaceEdit();
        const line = doc.lineAt(2);
        edit.insert(uri, line.range.end, "<");
        await vscode.workspace.applyEdit(edit);
        const pos = line.range.end.translate(0, 1);
        const list = await waitFor("tag completion", async () => {
            const l = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, pos, "<");
            return l && l.items.some((i) => (i.label.label ?? i.label) === "button") ? l : undefined;
        });
        const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, doc.positionAt(doc.getText().indexOf("size") + 1));
        const hoverText = (hover ?? []).flatMap((h) => h.contents).map((c) => c.value).join("\n");
        if (!/2D vector/.test(hoverText)) throw new Error(`hover: ${hoverText.slice(0, 200)}`);
        const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri);
        if (!symbols || symbols[0].name !== "<panel>") throw new Error(`outline: ${JSON.stringify(symbols)}`);
        const colors = await vscode.commands.executeCommand("vscode.executeDocumentColorProvider", uri);
        if (!colors || colors.length !== 1 || Math.abs(colors[0].color.green - 128 / 255) > 0.001) throw new Error(`colors: ${JSON.stringify(colors)}`);
        const presentations = await vscode.commands.executeCommand("vscode.executeColorPresentationProvider", colors[0].color, { uri, range: colors[0].range });
        if (!presentations || presentations[0].label !== "#FF8000") throw new Error(`presentations: ${JSON.stringify(presentations)}`);
        await vscode.commands.executeCommand("workbench.action.files.revert");
        return `${diags[0].message.slice(0, 70)}…, ${list.items.length} tags, hover + outline + colour picker`;
    });

    await check("XML layouts: Lua in callback attributes (highlighting, go to definition)", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "layouts", "lua.xml"));
        await vscode.window.showTextDocument(uri);
        // internal command used by VS Code's own colorizer tests
        const tokens = await waitFor("tokens", async () => {
            const t = await vscode.commands.executeCommand("_workbench.captureSyntaxTokens", uri);
            return t && t.length ? t : undefined;
        });
        const scopesOf = (text) => tokens.filter((t) => t.c === text).map((t) => t.t);
        const lua = (scope) => / meta\.embedded\.inline\.lua/.test(scope) && /source\.lua|\.lua\b/.test(scope);
        if (!scopesOf("function").some((s) => lua(s) && /keyword/.test(s))) throw new Error(`'function': ${JSON.stringify(scopesOf("function"))}`);
        if (!scopesOf("back").some(lua)) throw new Error(`'back': ${JSON.stringify(tokens.filter((t) => /back/.test(t.c)))}`);
        // the id value is a plain XML string
        const idValue = tokens.find((t) => t.c === "onclick" && /string/.test(t.t));
        if (!idValue || lua(idValue.t)) throw new Error(`id value: ${JSON.stringify(idValue)}`);
        // go to definition: refresh() → function refresh in lua.xml.lua, line 3
        const doc = await vscode.workspace.openTextDocument(uri);
        const defs = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uri, doc.positionAt(doc.getText().indexOf("refresh()") + 2));
        const def = defs && defs[0];
        const defUri = def && (def.uri ?? def.targetUri);
        const defRange = def && (def.range ?? def.targetRange);
        if (!defUri || !/lua.xml.lua$/.test(defUri.fsPath) || defRange.start.line !== 2) throw new Error(`definition: ${JSON.stringify(defs)}`);
        const undefinedNames = vscode.languages.getDiagnostics(uri).filter((d) => d.code && /VC041/.test(d.code.value));
        if (undefinedNames.length) throw new Error(`unexpected: ${undefinedNames.map((d) => d.message)}`);
        return `'function' → ${scopesOf("function").find(lua)}; refresh() → lua.xml.lua:3`;
    });

    await check("XML layouts: references and rename across the layout and its script", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "layouts", "lua.xml"));
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const files = (locs) => [...new Set((locs ?? []).map((l) => path.basename((l.uri ?? l.targetUri).fsPath)))].sort().join(",");
        const fnRefs = await vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, doc.positionAt(text.indexOf("refresh()") + 2));
        if (files(fnRefs) !== "lua.xml,lua.xml.lua") throw new Error(`function references: ${files(fnRefs)}`);
        const edit = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", uri, doc.positionAt(text.indexOf('"title"') + 2), "heading");
        const changed = edit ? edit.entries().map(([u, edits]) => `${path.basename(u.fsPath)}:${edits.length}`).sort().join(",") : "";
        if (changed !== "lua.xml.lua:1,lua.xml:1") throw new Error(`id rename: ${changed}`);
        return `refresh → ${files(fnRefs)}; rename title → ${changed}`;
    });

    await check("XML layouts: texture thumbnails, @key translations, document.<id>", async () => {
        const uri = vscode.Uri.file(path.join(root, "smoke", "layouts", "lua.xml"));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const gutter = await waitFor("gutter icon", async () => {
            const g = await vscode.commands.executeCommand("voxelcore.thumbnails.inspect", uri);
            return g && g.length && g[0].icon && fs.existsSync(g[0].icon) ? g : undefined;
        });
        const texHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, doc.positionAt(doc.getText().indexOf("gui/check_mark") + 3));
        if (!(texHover ?? []).some((h) => h.contents.some((c) => /data:image\/png;base64/.test(c.value)))) throw new Error("no texture image in the hover");
        const keyHover = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, doc.positionAt(doc.getText().indexOf("@Settings") + 2));
        const keyText = (keyHover ?? []).flatMap((h) => h.contents).map((c) => c.value).join("\n");
        if (!/menu\.Settings/.test(keyText)) throw new Error(`key hover: ${keyText.slice(0, 200)}`);
        // document.<id> in lua.xml.lua
        const scriptUri = vscode.Uri.file(path.join(root, "smoke", "layouts", "lua.xml.lua"));
        const script = await vscode.workspace.openTextDocument(scriptUri);
        await vscode.window.showTextDocument(script);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(scriptUri, script.positionAt(script.getText().length), "document.");
        await vscode.workspace.applyEdit(edit);
        const pos = script.positionAt(script.getText().length);
        const list = await waitFor("document ids", async () => {
            const l = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", scriptUri, pos, ".");
            return l && l.items.some((i) => (i.label.label ?? i.label) === "title") ? l : undefined;
        });
        await vscode.commands.executeCommand("workbench.action.files.revert");
        // the layout script's functions inside onclick, and the vc- snippets
        const layoutText = doc.getText();
        const inOnclick = doc.positionAt(layoutText.indexOf("refresh()") + 3);
        const fns = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, inOnclick);
        const refreshItem = fns && fns.items.find((i) => (i.label.label ?? i.label) === "refresh");
        if (!refreshItem) throw new Error(`no 'refresh' in onclick: ${fns && fns.items.slice(0, 10).map((i) => i.label.label ?? i.label)}`);
        const atEnd = doc.positionAt(layoutText.lastIndexOf("</panel>"));
        const snippetList = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", uri, atEnd);
        if (!snippetList || !snippetList.items.some((i) => (i.label.label ?? i.label) === "vc-button")) throw new Error("no vc-button snippet");
        return `${gutter.length} gutter icon(s), image hover, menu.Settings, refresh in onclick, vc- snippets, document.${list.items.filter((i) => ["title", "root"].includes(i.label.label ?? i.label)).map((i) => i.label.label ?? i.label).join("/")}`;
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
