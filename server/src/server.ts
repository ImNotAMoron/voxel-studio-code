// vcls — VoxelCore language server.

import * as fs from "node:fs";
import * as path from "node:path";
import {
    CodeActionKind, Diagnostic, DiagnosticSeverity, DiagnosticTag, DidChangeConfigurationNotification,
    FileChangeType, InitializeParams, InitializeResult, ProposedFeatures, TextDocumentSyncKind, TextDocuments,
    createConnection,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ContentIndex } from "../../shared/content/index";
import { CREATE_TEXTURE_COMMAND, codeActions, writePlaceholderTexture } from "./features/codeActions";
import { complete, definition, documentSymbols, hover } from "./features/language";
import { collectMentions, createEnv, fileRole, lintDocument, lintPack } from "./linter";
import { LintEnv } from "./rules/context";
import { LintSettings, SeverityOverride, ruleHref } from "./rules/registry";
import { VcDiagnostic } from "./rules/report";
import { SchemaStore } from "./schemas";
import { fileKey, fileToUri, uriToFile } from "./uri";

interface ServerSettings {
    resPath?: string;
    lint?: { enable?: boolean; rules?: Record<string, SeverityOverride> };
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceRoots: string[] = [];
let settings: ServerSettings = {};
let index = new ContentIndex();
const schemas = new SchemaStore();
let hasConfigurationCapability = false;
let hasWorkspaceFoldersCapability = false;
/** uri -> last published diagnostics count, to clear stale ones */
const published = new Map<string, number>();
/** documents whose content.json was edited in the editor */
const editedContentJson = new Set<string>();
const openVersions = new Map<string, number>();

function lintSettings(editor: boolean): LintSettings {
    return { unknownKeys: !editor, rules: settings.lint?.rules };
}

function env(): LintEnv {
    return createEnv(index, lintSettings(true), true, schemas);
}

function lintEnabled(): boolean {
    return settings.lint?.enable !== false;
}

function toLsp(doc: TextDocument, d: VcDiagnostic): Diagnostic {
    const severity = {
        error: DiagnosticSeverity.Error,
        warning: DiagnosticSeverity.Warning,
        information: DiagnosticSeverity.Information,
        hint: DiagnosticSeverity.Hint,
    }[d.severity];
    const tags: DiagnosticTag[] = [];
    if (d.tags?.includes("unnecessary")) tags.push(DiagnosticTag.Unnecessary);
    if (d.tags?.includes("deprecated")) tags.push(DiagnosticTag.Deprecated);
    return {
        range: { start: doc.positionAt(d.start), end: doc.positionAt(d.end) },
        severity,
        code: d.code,
        codeDescription: { href: ruleHref(d.code) },
        source: "voxelcore",
        message: d.message,
        tags: tags.length ? tags : undefined,
        data: d.data,
    };
}

function publish(uri: string, doc: TextDocument, list: VcDiagnostic[]) {
    const diagnostics = list.map((d) => toLsp(doc, d));
    if (!diagnostics.length && !published.get(uri)) return;
    published.set(uri, diagnostics.length);
    void connection.sendDiagnostics({ uri, diagnostics });
}

function openDocFor(file: string): TextDocument | undefined {
    const key = fileKey(file);
    return documents.all().find((d) => {
        const f = uriToFile(d.uri);
        return f !== undefined && fileKey(f) === key;
    });
}

function textOf(file: string): string | undefined {
    const doc = openDocFor(file);
    if (doc) return doc.getText();
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

function lintOpenDocument(doc: TextDocument) {
    if (!lintEnabled()) return;
    const file = uriToFile(doc.uri);
    if (!file) return;
    const { role } = fileRole(index, file);
    if (role === "other" && !/\.(vcm|vca|lua)$/i.test(file)) return;
    const diagnostics = lintDocument(env(), file, doc.getText(), { contentJsonEdited: editedContentJson.has(doc.uri) });
    // keep asset-level hints computed by the workspace pass? they live on asset files, not documents
    publish(doc.uri, doc, diagnostics);
}

/** Lints every workspace pack (open documents use their live text). */
function lintWorkspace() {
    if (!lintEnabled()) {
        clearAll();
        return;
    }
    const e = env();
    const mentions = collectMentions(index, textOf);
    const seen = new Set<string>();
    for (const pack of index.lintablePacks()) {
        const results = lintPack(e, pack, textOf, mentions);
        for (const [file, list] of results) {
            const open = openDocFor(file);
            const uri = open?.uri ?? fileToUri(file);
            seen.add(uri);
            if (open) {
                const extra = lintDocument(e, file, open.getText(), { contentJsonEdited: editedContentJson.has(open.uri) });
                const assetLevel = list.filter((d) => d.start === 0 && d.end === 0 && ["VC0060", "VC0061", "VC0062"].includes(d.code));
                publish(uri, open, [...extra, ...assetLevel]);
            } else {
                const text = /\.(png|ogg|wav|vec3)$/i.test(file) ? "" : textOf(file) ?? "";
                publish(uri, TextDocument.create(uri, "plaintext", 0, text), list);
            }
        }
    }
    // open documents outside packs (vcm/vca anywhere)
    for (const doc of documents.all()) {
        if (!seen.has(doc.uri)) {
            lintOpenDocument(doc);
            seen.add(doc.uri);
        }
    }
    for (const uri of [...published.keys()]) {
        if (!seen.has(uri) && published.get(uri)) {
            published.set(uri, 0);
            void connection.sendDiagnostics({ uri, diagnostics: [] });
        }
    }
}

function clearAll() {
    for (const [uri, count] of published) {
        if (count) void connection.sendDiagnostics({ uri, diagnostics: [] });
    }
    published.clear();
}

let workspaceTimer: NodeJS.Timeout | undefined;
function scheduleWorkspaceLint(delay = 400) {
    if (workspaceTimer) clearTimeout(workspaceTimer);
    workspaceTimer = setTimeout(() => {
        workspaceTimer = undefined;
        try {
            lintWorkspace();
        } catch (err) {
            connection.console.error(`vcls: workspace lint failed: ${(err as Error).stack ?? err}`);
        }
    }, delay);
}

const docTimers = new Map<string, NodeJS.Timeout>();
function scheduleDocumentLint(doc: TextDocument, delay = 150) {
    const timer = docTimers.get(doc.uri);
    if (timer) clearTimeout(timer);
    docTimers.set(doc.uri, setTimeout(() => {
        docTimers.delete(doc.uri);
        const current = documents.get(doc.uri);
        if (current) lintOpenDocument(current);
    }, delay));
}

function rebuildIndex() {
    index = new ContentIndex({ roots: workspaceRoots, resPath: settings.resPath || undefined });
    for (const doc of documents.all()) {
        const file = uriToFile(doc.uri);
        if (file) index.updateFile(file, doc.getText());
    }
}

function applySettings(next: ServerSettings | undefined) {
    const prevRes = settings.resPath;
    settings = { ...settings, ...(next ?? {}) };
    if (next?.lint) settings.lint = { ...next.lint };
    if (settings.resPath !== prevRes) rebuildIndex();
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
    const options = (params.initializationOptions ?? {}) as ServerSettings;
    settings = { resPath: options.resPath, lint: options.lint };
    hasConfigurationCapability = !!params.capabilities.workspace?.configuration;
    hasWorkspaceFoldersCapability = !!params.capabilities.workspace?.workspaceFolders;
    workspaceRoots = (params.workspaceFolders ?? []).map((f) => uriToFile(f.uri)).filter((f): f is string => !!f);
    if (!workspaceRoots.length && params.rootUri) {
        const root = uriToFile(params.rootUri);
        if (root) workspaceRoots = [root];
    }
    index = new ContentIndex({ roots: workspaceRoots, resPath: settings.resPath || undefined });
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { triggerCharacters: ['"', "'", "@", ":", "/", " ", "."], resolveProvider: false },
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
            executeCommandProvider: { commands: [CREATE_TEXTURE_COMMAND] },
            workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
        },
        serverInfo: { name: "vcls", version: "0.1.0" },
    };
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        void connection.client.register(DidChangeConfigurationNotification.type, { section: "voxelcore" });
        void pullConfiguration();
    }
    if (hasWorkspaceFoldersCapability) connection.workspace.onDidChangeWorkspaceFolders((event) => {
        const removed = new Set(event.removed.map((f) => uriToFile(f.uri)).filter(Boolean).map((f) => fileKey(f!)));
        workspaceRoots = workspaceRoots.filter((r) => !removed.has(fileKey(r)));
        for (const f of event.added) {
            const p = uriToFile(f.uri);
            if (p) workspaceRoots.push(p);
        }
        rebuildIndex();
        scheduleWorkspaceLint(0);
    });
    scheduleWorkspaceLint(0);
});

async function pullConfiguration() {
    try {
        const config = (await connection.workspace.getConfiguration("voxelcore")) as ServerSettings | null;
        if (config) {
            applySettings({ resPath: config.resPath, lint: config.lint });
            scheduleWorkspaceLint(0);
        }
    } catch {
        // client without workspace/configuration
    }
}

connection.onDidChangeConfiguration((change) => {
    const section = (change.settings as { voxelcore?: ServerSettings } | null)?.voxelcore;
    if (section) {
        applySettings({ resPath: section.resPath, lint: section.lint });
        scheduleWorkspaceLint(0);
    } else if (hasConfigurationCapability) {
        void pullConfiguration();
    }
});

documents.onDidOpen((event) => {
    const file = uriToFile(event.document.uri);
    openVersions.set(event.document.uri, event.document.version);
    if (file) index.updateFile(file, event.document.getText());
    scheduleDocumentLint(event.document, 0);
});

documents.onDidChangeContent((event) => {
    const doc = event.document;
    const file = uriToFile(doc.uri);
    if (!file) return;
    if (doc.version !== openVersions.get(doc.uri) && path.basename(file) === "content.json" && fileRole(index, file).role === "content") {
        editedContentJson.add(doc.uri);
    }
    index.updateFile(file, doc.getText());
    scheduleDocumentLint(doc);
});

documents.onDidSave(() => scheduleWorkspaceLint());

documents.onDidClose((event) => {
    const file = uriToFile(event.document.uri);
    editedContentJson.delete(event.document.uri);
    openVersions.delete(event.document.uri);
    if (file) index.clearOverlay(file);
    scheduleWorkspaceLint();
    // documents outside of packs: clear their diagnostics
    if (file && !index.packForFile(file) && published.get(event.document.uri)) {
        published.set(event.document.uri, 0);
        void connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
    }
});

connection.onDidChangeWatchedFiles((params) => {
    for (const change of params.changes) {
        const file = uriToFile(change.uri);
        if (!file || openDocFor(file)) continue;
        if (change.type === FileChangeType.Deleted) index.removeFile(file);
        else index.updateFile(file);
    }
    scheduleWorkspaceLint();
});

function docAndFile(uri: string): { doc: TextDocument; file: string } | undefined {
    const doc = documents.get(uri);
    const file = uriToFile(uri);
    return doc && file ? { doc, file } : undefined;
}

connection.onCompletion((params) => {
    const ctx = docAndFile(params.textDocument.uri);
    if (!ctx) return [];
    try {
        return complete(env(), ctx.doc, ctx.file, ctx.doc.offsetAt(params.position));
    } catch (err) {
        connection.console.error(`vcls completion: ${(err as Error).stack ?? err}`);
        return [];
    }
});

connection.onHover((params) => {
    const ctx = docAndFile(params.textDocument.uri);
    if (!ctx) return null;
    try {
        return hover(env(), ctx.doc, ctx.file, ctx.doc.offsetAt(params.position));
    } catch {
        return null;
    }
});

connection.onDefinition((params) => {
    const ctx = docAndFile(params.textDocument.uri);
    if (!ctx) return [];
    try {
        return definition(env(), ctx.doc, ctx.file, ctx.doc.offsetAt(params.position));
    } catch {
        return [];
    }
});

connection.onDocumentSymbol((params) => {
    const ctx = docAndFile(params.textDocument.uri);
    if (!ctx) return [];
    return documentSymbols(ctx.doc, ctx.file);
});

connection.onCodeAction((params) => {
    const ctx = docAndFile(params.textDocument.uri);
    if (!ctx) return [];
    try {
        return codeActions(env(), ctx.doc, ctx.file, params.context.diagnostics);
    } catch (err) {
        connection.console.error(`vcls code actions: ${(err as Error).stack ?? err}`);
        return [];
    }
});

connection.onExecuteCommand((params) => {
    if (params.command === CREATE_TEXTURE_COMMAND) {
        const target = params.arguments?.[0];
        if (typeof target === "string") {
            writePlaceholderTexture(target);
            index.updateFile(target);
            scheduleWorkspaceLint(0);
            void connection.window.showDocument({ uri: fileToUri(target) });
        }
    }
});

documents.listen(connection);
connection.listen();
