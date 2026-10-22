// Definition JSON with source spans, for the block / entity preview builders.
// Pure (no Node / DOM): the host reads files and passes their text.

import { findNodeAtLocation, getNodeValue, parseTree, type JSONPath, type Node, type ParseError } from "jsonc-parser";

import { sanitizeJson } from "../content/json";
import type { ModelError, SourceRef } from "./types";

/** Text of one definition file; `file` absent = the previewed document. */
export interface DefText {
    text: string;
    file?: string;
}

export class JsonDef {
    readonly tree: Node | undefined;
    readonly value: unknown;
    readonly errors: ModelError[] = [];

    constructor(readonly source: DefText) {
        const parseErrors: ParseError[] = [];
        // engine JSON: `#` comments and trailing commas (src/coders/json.cpp)
        this.tree = parseTree(sanitizeJson(source.text), parseErrors, { allowTrailingComma: true, disallowComments: false });
        this.value = this.tree ? getNodeValue(this.tree) : undefined;
        if (parseErrors.length > 0 && !source.file) {
            const e = parseErrors[0];
            this.errors.push({ message: "JSON syntax error", span: { start: e.offset, end: e.offset + Math.max(1, e.length) }, severity: "error" });
        }
    }

    get file(): string | undefined {
        return this.source.file;
    }

    /** Root object, or undefined. */
    get root(): Record<string, unknown> | undefined {
        return isObject(this.value) ? this.value : undefined;
    }

    /** Span of the value at `path`. */
    ref(path: JSONPath): SourceRef | undefined {
        if (!this.tree) return undefined;
        const node = findNodeAtLocation(this.tree, path);
        if (!node) return undefined;
        const ref: SourceRef = { span: { start: node.offset, end: node.offset + node.length } };
        if (this.source.file) ref.file = this.source.file;
        return ref;
    }
}

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Thrown where dv::value would throw a type error (src/data/dv.cpp). */
export class DefTypeError extends Error {}

/** dv::value::asNumber: numbers only. */
export function asNumber(value: unknown, what: string): number {
    if (typeof value === "number") return value;
    throw new DefTypeError(`${what}: number expected`);
}

/** dv::value::asInteger: numbers, truncated (static_cast<integer_t>). */
export function asInteger(value: unknown, what: string): number {
    return Math.trunc(asNumber(value, what));
}

/** dv::value::asString: strings only. */
export function asString(value: unknown, what: string): string {
    if (typeof value === "string") return value;
    throw new DefTypeError(`${what}: string expected`);
}

/** dv::value::asBoolean: booleans (null reads as false). */
export function asBoolean(value: unknown, what: string): boolean {
    if (typeof value === "boolean") return value;
    if (value === null) return false;
    throw new DefTypeError(`${what}: boolean expected`);
}
