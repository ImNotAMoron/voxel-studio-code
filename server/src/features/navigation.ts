// LSP glue for references.ts: locations, rename edits, symbols and lenses.

import * as path from "node:path";
import {
    ChangeAnnotation, CodeLens, Location, Range, RenameFile, ResponseError, SymbolInformation, SymbolKind,
    TextDocumentEdit, WorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { fileKey, fileToUri } from "../uri";
import { ContentSymbol, RenamePlan, ReferenceIndex, SymbolKindName, symbolOfFile } from "./references";

/** Client-side command (src/extension.ts) that opens the references peek. */
export const SHOW_REFERENCES_COMMAND = "voxelcore.showReferences";

type GetText = (file: string) => string | undefined;

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

/** Positions in files that aren't open: one TextDocument per file and request. */
class Positions {
    private readonly docs = new Map<string, TextDocument | undefined>();
    constructor(private readonly getText: GetText) {}

    range(file: string, start: number, end: number): Range {
        const key = fileKey(file);
        if (!this.docs.has(key)) {
            const text = this.getText(file);
            this.docs.set(key, text === undefined ? undefined : TextDocument.create(fileToUri(file), "plaintext", 0, text));
        }
        const doc = this.docs.get(key);
        return doc ? { start: doc.positionAt(start), end: doc.positionAt(end) } : ZERO;
    }
}

export function findReferences(refs: ReferenceIndex, doc: TextDocument, file: string, offset: number, includeDeclaration: boolean, getText: GetText): Location[] {
    const at = refs.symbolAt(file, doc.getText(), offset);
    if (!at) return [];
    return symbolReferences(refs, at.symbol, includeDeclaration, getText);
}

export function symbolReferences(refs: ReferenceIndex, symbol: ContentSymbol, includeDeclaration: boolean, getText: GetText): Location[] {
    const positions = new Positions(getText);
    const out: Location[] = [];
    if (includeDeclaration) out.push({ uri: fileToUri(symbol.file), range: ZERO });
    for (const ref of refs.references(symbol)) {
        out.push({ uri: fileToUri(ref.file), range: positions.range(ref.file, ref.start, ref.end) });
    }
    return out;
}

export function prepareRename(refs: ReferenceIndex, doc: TextDocument, file: string, offset: number): { range: Range; placeholder: string } | ResponseError<void> {
    const at = refs.symbolAt(file, doc.getText(), offset);
    if (!at?.ref) {
        return new ResponseError(0, "Rename a VoxelCore id from one of its references, or rename the file in the Explorer");
    }
    if (at.symbol.pack.builtin) return new ResponseError(0, `${at.symbol.id} belongs to the built-in pack '${at.symbol.pack.id}'`);
    const range = refs.nameRange(at.ref, at.symbol);
    if (!range) return new ResponseError(0, `can't find '${at.symbol.name}' in '${at.ref.value}'`);
    return { range: { start: doc.positionAt(range.start), end: doc.positionAt(range.end) }, placeholder: at.symbol.name };
}

export function rename(refs: ReferenceIndex, doc: TextDocument, file: string, offset: number, newName: string, getText: GetText): WorkspaceEdit | ResponseError<void> {
    const at = refs.symbolAt(file, doc.getText(), offset);
    if (!at) return new ResponseError(0, "no VoxelCore id here");
    return renameSymbol(refs, at.symbol, newName, getText);
}

export function renameSymbol(refs: ReferenceIndex, symbol: ContentSymbol, newName: string, getText: GetText): WorkspaceEdit | ResponseError<void> {
    const plan = refs.planRename(symbol, newName);
    if (typeof plan === "string") return new ResponseError(0, plan);
    const now = Date.now();
    for (const r of plan.renames) ownRenames.set(fileKey(r.from), now);
    return toWorkspaceEdit(plan, getText);
}

/**
 * File renames of our own rename edits. VS Code runs `willRenameFiles`
 * participants for WorkspaceEdit renames too; those references are already
 * updated by the same edit.
 */
const ownRenames = new Map<string, number>();
const OWN_RENAME_TTL = 120_000;

function isOwnRename(file: string): boolean {
    const key = fileKey(file);
    const at = ownRenames.get(key);
    for (const [k, t] of ownRenames) if (Date.now() - t > OWN_RENAME_TTL) ownRenames.delete(k);
    if (at === undefined || Date.now() - at > OWN_RENAME_TTL) return false;
    ownRenames.delete(key);
    return true;
}

const UNIT_ANNOTATION = "voxelcore.unitRename";

export function toWorkspaceEdit(plan: RenamePlan, getText: GetText): WorkspaceEdit {
    const positions = new Positions(getText);
    const annotationId = plan.unit ? UNIT_ANNOTATION : undefined;
    const documentChanges: (TextDocumentEdit | RenameFile)[] = [];
    for (const [file, edits] of plan.edits) {
        documentChanges.push({
            textDocument: { uri: fileToUri(file), version: null },
            edits: edits.map((e) => ({ range: positions.range(file, e.start, e.end), newText: e.newText, ...(annotationId ? { annotationId } : {}) })),
        });
    }
    for (const r of plan.renames) {
        documentChanges.push({ kind: "rename", oldUri: fileToUri(r.from), newUri: fileToUri(r.to), ...(annotationId ? { annotationId } : {}) });
    }
    const edit: WorkspaceEdit = { documentChanges };
    if (annotationId) {
        const annotation: ChangeAnnotation = {
            label: `Rename ${plan.symbol.kind} ${plan.symbol.id}`,
            description:
                "Unit names are stored in worlds: existing worlds will ask to convert their content indices. " +
                "content.json keeps the unit at its position, so other units keep their indices.",
            needsConfirmation: true,
        };
        edit.changeAnnotations = { [annotationId]: annotation };
    }
    return edit;
}

/**
 * `workspace/willRenameFiles` from the Explorer: when a definition or asset
 * keeps its folder and extension, update the references to its new stem.
 */
export function willRenameFiles(refs: ReferenceIndex, files: { from: string; to: string }[], getText: GetText): WorkspaceEdit | null {
    const merged: RenamePlan = { symbol: undefined!, edits: new Map(), renames: [], unit: false };
    for (const { from, to } of files) {
        if (isOwnRename(from)) continue;
        if (fileKey(path.dirname(from)) !== fileKey(path.dirname(to))) continue;
        const symbol = symbolOfFile(refs.contentIndex, from);
        if (!symbol || fileKey(symbol.file) !== fileKey(from)) continue;
        const ext = fromExt(symbol, from);
        if (!path.basename(to).endsWith(ext)) continue;
        const newName = path.basename(to).slice(0, -ext.length || undefined);
        const plan = refs.planRename(symbol, newName, { renameFiles: false });
        if (typeof plan === "string") continue;
        merged.symbol ??= plan.symbol;
        merged.unit ||= plan.unit;
        for (const [file, edits] of plan.edits) merged.edits.set(file, [...(merged.edits.get(file) ?? []), ...edits]);
    }
    if (!merged.edits.size) return null;
    return toWorkspaceEdit(merged, getText);
}

/** The part of the file name after the symbol's name (`.json`, `.png`, `_0.ogg`, `.xml`). */
function fromExt(symbol: ContentSymbol, file: string): string {
    const base = path.basename(file);
    return base.startsWith(symbol.name) ? base.slice(symbol.name.length) : path.extname(base);
}

const SYMBOL_KINDS: Record<SymbolKindName, SymbolKind> = {
    block: SymbolKind.Constant,
    item: SymbolKind.Field,
    entity: SymbolKind.Class,
    texture: SymbolKind.File,
    model: SymbolKind.Struct,
    sound: SymbolKind.Event,
    skeleton: SymbolKind.TypeParameter,
    material: SymbolKind.EnumMember,
    component: SymbolKind.Class,
    layout: SymbolKind.Interface,
    module: SymbolKind.Module,
    script: SymbolKind.Method,
};

export function workspaceSymbols(refs: ReferenceIndex, query: string): SymbolInformation[] {
    return refs.workspaceSymbols(query).slice(0, 1000).map((s) => ({
        name: s.id,
        kind: SYMBOL_KINDS[s.kind],
        containerName: `${s.kind} · ${s.pack.id}`,
        location: { uri: fileToUri(s.file), range: ZERO },
    }));
}

/** "N references" above a definition, module or model. */
export function codeLenses(refs: ReferenceIndex, file: string, getText: GetText): CodeLens[] {
    const symbol = symbolOfFile(refs.contentIndex, file);
    if (!symbol || fileKey(symbol.file) !== fileKey(file)) return [];
    const locations = symbolReferences(refs, symbol, false, getText);
    const n = locations.length;
    const lenses: CodeLens[] = [{
        range: ZERO,
        command: {
            title: n === 1 ? "1 reference" : `${n} references`,
            command: n ? SHOW_REFERENCES_COMMAND : "",
            arguments: n ? [fileToUri(file), ZERO.start, locations] : undefined,
        },
    }];
    if (symbol.kind === "script") {
        const users = refs.contentIndex.scriptUsers(symbol.pack.id, symbol.name);
        if (users.length) {
            lenses.push({
                range: ZERO,
                command: { title: `script of ${users.map((u) => u.id).join(", ")}`, command: "" },
            });
        }
    }
    return lenses;
}
