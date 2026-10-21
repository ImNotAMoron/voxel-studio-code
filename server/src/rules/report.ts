import { Node, ParseError, parseTree, findNodeAtLocation, printParseErrorCode } from "jsonc-parser";
import { sanitizeJson } from "../../../shared/content/json";
import { LintSettings, Severity, effectiveSeverity } from "./registry";

export type DiagnosticTag = "unnecessary" | "deprecated";

export interface VcDiagnostic {
    file: string;
    code: string;
    severity: Severity;
    message: string;
    /** String offsets into the file text. */
    start: number;
    end: number;
    tags?: DiagnosticTag[];
    /** Extra info for quick fixes. */
    data?: Record<string, unknown>;
}

export interface ReportOptions {
    severity?: Severity;
    tags?: DiagnosticTag[];
    data?: Record<string, unknown>;
}

export class Report {
    readonly diagnostics: VcDiagnostic[] = [];

    constructor(readonly file: string, readonly settings: LintSettings = {}) {}

    add(code: string, start: number, end: number, message: string, options: ReportOptions = {}) {
        const override = this.settings.rules?.[code];
        if (override === "off") return;
        const severity = override ?? options.severity ?? effectiveSeverity(code, this.settings);
        if (!severity) return;
        this.diagnostics.push({
            file: this.file,
            code,
            severity,
            message,
            start,
            end: Math.max(end, start),
            tags: options.tags,
            data: options.data,
        });
    }

    /** Reports at a JSON node (value range); falls back to the file start. */
    node(code: string, node: Node | undefined, message: string, options?: ReportOptions) {
        if (node) this.add(code, node.offset, node.offset + node.length, message, options);
        else this.add(code, 0, 0, message, options);
    }
}

export interface JsonDoc {
    text: string;
    root: Node | undefined;
    value: unknown;
    errors: ParseError[];
}

export function parseJsonDoc(text: string): JsonDoc {
    const errors: ParseError[] = [];
    const root = parseTree(sanitizeJson(text), errors, { allowTrailingComma: true, disallowComments: false });
    let value: unknown;
    try {
        value = root ? nodeValue(root) : undefined;
    } catch {
        value = undefined;
    }
    return { text, root, value, errors };
}

export function jsonErrorMessage(error: ParseError): string {
    return printParseErrorCode(error.error);
}

export function nodeValue(node: Node): unknown {
    switch (node.type) {
        case "object": {
            const obj: Record<string, unknown> = {};
            for (const prop of node.children ?? []) {
                const [key, value] = prop.children ?? [];
                if (key && value) obj[key.value as string] = nodeValue(value);
            }
            return obj;
        }
        case "array":
            return (node.children ?? []).map(nodeValue);
        default:
            return node.value;
    }
}

export function at(root: Node | undefined, path: (string | number)[]): Node | undefined {
    return root ? findNodeAtLocation(root, path) : undefined;
}

/** The property node (key + value) of `key` in object `obj`. */
export function propertyNode(obj: Node | undefined, key: string): Node | undefined {
    if (!obj || obj.type !== "object") return undefined;
    return obj.children?.find((p) => p.children?.[0]?.value === key);
}

export function keyNode(obj: Node | undefined, key: string): Node | undefined {
    return propertyNode(obj, key)?.children?.[0];
}

export function objectEntries(obj: Node | undefined): { key: string; keyNode: Node; valueNode: Node | undefined }[] {
    if (!obj || obj.type !== "object") return [];
    const result = [];
    for (const prop of obj.children ?? []) {
        const k = prop.children?.[0];
        if (!k) continue;
        result.push({ key: String(k.value), keyNode: k, valueNode: prop.children?.[1] });
    }
    return result;
}

export function arrayItems(node: Node | undefined): Node[] {
    return node && node.type === "array" ? node.children ?? [] : [];
}

export function str(node: Node | undefined): string | undefined {
    return node && node.type === "string" ? (node.value as string) : undefined;
}

export function num(node: Node | undefined): number | undefined {
    return node && node.type === "number" ? (node.value as number) : undefined;
}

export function bool(node: Node | undefined): boolean | undefined {
    return node && node.type === "boolean" ? (node.value as boolean) : undefined;
}

/** Line/column (0-based) of an offset. */
export function offsetToLineCol(text: string, offset: number): { line: number; character: number } {
    let line = 0;
    let lineStart = 0;
    const end = Math.min(offset, text.length);
    for (let i = 0; i < end; i++) {
        if (text.charCodeAt(i) === 10) {
            line++;
            lineStart = i + 1;
        }
    }
    return { line, character: end - lineStart };
}
