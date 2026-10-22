// One ContentIndex for the extension host (previews, content explorer, log
// mapping). The language server keeps its own; this one is rebuilt lazily
// after files are created, deleted or saved.
import * as vscode from "vscode";
import { ContentIndex } from "../shared/content";
import { findResPath } from "./packs";

const REBUILD_DELAY = 300;

class WorkspaceIndex implements vscode.Disposable {
    private index: ContentIndex | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    /** Fired after `invalidate` (the next `get` rebuilds). */
    readonly onDidChange = this.changed.event;

    get(): ContentIndex {
        if (!this.index) {
            this.index = new ContentIndex({
                resPath: findResPath(),
                roots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
            });
        }
        return this.index;
    }

    /** Something on disk changed: drop the index after a short delay. */
    invalidate() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.index = undefined;
            this.changed.fire();
        }, REBUILD_DELAY);
    }

    dispose() {
        clearTimeout(this.timer);
        this.changed.dispose();
    }
}

export const workspaceIndex = new WorkspaceIndex();

export function registerWorkspaceIndex(context: vscode.ExtensionContext) {
    // creates/deletes change the units; saves change captions, textures, parents
    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{json,toml,lua,vcm,vca,obj,vec3,png,ogg,wav,xml,txt}");
    const invalidate = () => workspaceIndex.invalidate();
    context.subscriptions.push(
        workspaceIndex,
        watcher,
        watcher.onDidCreate(invalidate),
        watcher.onDidDelete(invalidate),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (/\.(json|toml|txt)$/i.test(doc.uri.fsPath)) invalidate();
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("voxelcore.resPath")) invalidate();
        })
    );
}
