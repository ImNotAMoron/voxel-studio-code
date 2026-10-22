// Live hot reload (FEATURES.md §4.2): saved files reach the running engine.
// Assets go through VC-DBG `hot-reload`, modules and content through the
// quick-world dev bridge (plan.ts, bridge.ts, src/debug/channels.ts).
import * as vscode from "vscode";
import { engineChannels, type EngineChannel } from "../debug/channels";
import { hotReloadMessage } from "../debug/vcdbg";
import { workspaceIndex } from "../workspaceIndex";
import { sendBridgeRequest, waitForAck, type BridgeRequest } from "./bridge";
import { reloadActionFor, type ReloadAction } from "./plan";

/** Binary assets edited outside VS Code (Aseprite, Blockbench…). */
const WATCHED = "**/*.{png,vcm,obj,vec3,vca,glsl}";

export function registerHotReload(context: vscode.ExtensionContext) {
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 9);
    status.command = "voxelcore.reloadContent";
    const output = vscode.window.createOutputChannel("VoxelCore Hot Reload", { log: true });
    let last = "";

    const updateStatus = () => {
        const channel = engineChannels.current();
        if (!channel || !vscode.workspace.getConfiguration("voxelcore").get<boolean>("hotReload.enable", true)) {
            status.hide();
            return;
        }
        status.text = "$(flame) hot reload";
        status.tooltip = new vscode.MarkdownString(
            `Hot reload: on (${channel.label}, port ${channel.port})` +
                (last ? `\n\nlast: ${last}` : "") +
                (channel.bridge ? "\n\nClick to reload content (reopens the world)" : "\n\nModules and content reload need *Run Quick World*")
        );
        status.show();
    };

    const report = (text: string, level: "info" | "warn" = "info") => {
        last = text;
        output[level](text);
        updateStatus();
        vscode.window.setStatusBarMessage(`$(flame) ${text}`, 4000);
    };

    const bridge = async (channel: EngineChannel, request: BridgeRequest, label: string) => {
        if (!channel.bridge) {
            report(`${label}: needs the quick world launch (dev bridge) to reload`, "warn");
            return;
        }
        const ack = await waitForAck(channel.userDir, sendBridgeRequest(channel.userDir, request), 30000);
        if (!ack) report(`${label}: no answer from the engine's app script`, "warn");
        else if (!ack.ok) {
            report(`${label}: ${ack.error}`, "warn");
            vscode.window.showWarningMessage(`VoxelCore hot reload failed: ${ack.error}`);
        } else report(`reloaded ${label}`);
    };

    const reloadContent = async (channel: EngineChannel) => bridge(channel, { op: "reload_content" }, "content");

    let contentPrompt: PromiseLike<unknown> | undefined;
    const run = async (action: ReloadAction) => {
        const channel = engineChannels.current();
        if (!channel) return;
        switch (action.kind) {
            case "asset":
                for (const file of action.files) channel.client.send(hotReloadMessage(file));
                report(`reloaded ${action.label}`);
                return;
            case "module":
                return bridge(channel, { op: "reload_module", name: action.name }, action.name);
            case "restart":
                report(`${action.label}: ${action.reason}; restart the engine to see it`);
                return;
            case "content": {
                const mode = vscode.workspace.getConfiguration("voxelcore").get<string>("hotReload.content", "ask");
                if (mode === "off") return;
                if (mode === "auto") return reloadContent(channel);
                if (contentPrompt) return; // one question for a burst of saves
                contentPrompt = vscode.window
                    .showInformationMessage(`${action.label} changed. Reload content in the engine? This reopens the world.`, "Reload", "Always")
                    .then(async (answer) => {
                        if (answer === "Always") {
                            await vscode.workspace.getConfiguration("voxelcore").update("hotReload.content", "auto", vscode.ConfigurationTarget.Workspace);
                        }
                        if (answer) await reloadContent(channel);
                    })
                    .then(() => (contentPrompt = undefined), () => (contentPrompt = undefined));
                return;
            }
        }
    };

    // several events for one save (editor save + watcher): one reload per file
    const recent = new Map<string, number>();
    const onFile = (uri: vscode.Uri) => {
        if (uri.scheme !== "file" || !engineChannels.current()) return;
        if (!vscode.workspace.getConfiguration("voxelcore").get<boolean>("hotReload.enable", true)) return;
        const now = Date.now();
        if (now - (recent.get(uri.fsPath) ?? 0) < 500) return;
        recent.set(uri.fsPath, now);
        const action = reloadActionFor(workspaceIndex.get(), uri.fsPath);
        if (action) void run(action);
    };

    const watcher = vscode.workspace.createFileSystemWatcher(WATCHED, true, false, true);
    context.subscriptions.push(
        status,
        output,
        watcher,
        watcher.onDidChange(onFile),
        vscode.workspace.onDidSaveTextDocument((doc) => onFile(doc.uri)),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore.hotReload")) updateStatus();
        }),
        vscode.commands.registerCommand("voxelcore.reloadContent", async () => {
            const channel = engineChannels.current();
            if (!channel) {
                vscode.window.showInformationMessage("No running engine. Start one with VoxelCore: Run Quick World.");
                return;
            }
            await reloadContent(channel);
        }),
        vscode.commands.registerCommand("voxelcore.hotReload.inspect", () => ({ last, channels: engineChannels.all().map((c) => ({ port: c.port, owner: c.owner, bridge: c.bridge })) }))
    );
    engineChannels.on("change", updateStatus);
    context.subscriptions.push({ dispose: () => engineChannels.off("change", updateStatus) });
}
