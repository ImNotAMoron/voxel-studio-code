// A small JSON Schema (draft-07 subset) validator and structural checker,
// covering exactly the keywords used by schemas/*.schema.json.

export type Schema = Record<string, any> | boolean;

export interface ValidationError {
    path: string;
    message: string;
}

export type SchemaLoader = (file: string) => Schema;

/** draft-07 keywords + VS Code extensions we allow in generated schemas. */
export const KNOWN_KEYWORDS = new Set([
    // core / meta
    "$schema", "$id", "$ref", "$comment", "title", "description", "default", "examples", "definitions",
    // validation
    "type", "enum", "const", "properties", "additionalProperties", "patternProperties", "propertyNames",
    "required", "minProperties", "maxProperties", "items", "additionalItems", "minItems", "maxItems",
    "uniqueItems", "contains", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "pattern", "minLength", "maxLength", "format", "oneOf", "anyOf", "allOf", "not", "if", "then", "else",
    "dependencies",
    // VS Code JSON language service extensions
    "markdownDescription", "enumDescriptions", "markdownEnumDescriptions", "defaultSnippets",
    "errorMessage", "patternErrorMessage", "deprecationMessage", "doNotSuggest", "allowComments",
    "allowTrailingCommas",
]);

const SCHEMA_MAPS = ["properties", "patternProperties", "definitions"];
const SCHEMA_SINGLE = ["additionalProperties", "propertyNames", "additionalItems", "contains", "not", "if", "then", "else"];
const SCHEMA_ARRAYS = ["oneOf", "anyOf", "allOf"];
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function resolvePointer(root: any, pointer: string): any {
    if (pointer === "" || pointer === "#") return root;
    return pointer
        .replace(/^#?\//, "")
        .split("/")
        .reduce((o, k) => (o === undefined ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), root);
}

/** Structural (meta-schema-like) check of a schema. Returns problems. */
export function checkSchemaStructure(schema: Schema, load?: SchemaLoader): string[] {
    const problems: string[] = [];
    const root = schema;
    const visit = (node: any, at: string) => {
        if (typeof node === "boolean") return;
        if (!isObj(node)) {
            problems.push(`${at}: schema must be an object or boolean`);
            return;
        }
        for (const k of Object.keys(node)) {
            if (!KNOWN_KEYWORDS.has(k)) problems.push(`${at}: unknown keyword ${JSON.stringify(k)}`);
        }
        if (node.type !== undefined) {
            const types = Array.isArray(node.type) ? node.type : [node.type];
            for (const t of types) if (!TYPES.has(t)) problems.push(`${at}: invalid type ${JSON.stringify(t)}`);
        }
        if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
            problems.push(`${at}: enum must be a non-empty array`);
        }
        for (const k of ["enumDescriptions", "markdownEnumDescriptions"]) {
            if (node[k] !== undefined && (!Array.isArray(node[k]) || node[k].length !== node.enum?.length)) {
                problems.push(`${at}: ${k} must match enum length`);
            }
        }
        if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every((x: any) => typeof x === "string"))) {
            problems.push(`${at}: required must be an array of strings`);
        }
        for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
            if (node[k] !== undefined && typeof node[k] !== "number") problems.push(`${at}: ${k} must be a number`);
        }
        for (const k of ["minItems", "maxItems", "minLength", "maxLength", "minProperties", "maxProperties"]) {
            if (node[k] !== undefined && !(Number.isInteger(node[k]) && node[k] >= 0)) {
                problems.push(`${at}: ${k} must be a non-negative integer`);
            }
        }
        for (const k of ["description", "markdownDescription", "title", "errorMessage", "deprecationMessage", "$id", "$schema"]) {
            if (node[k] !== undefined && typeof node[k] !== "string") problems.push(`${at}: ${k} must be a string`);
        }
        if (node.pattern !== undefined) {
            try {
                new RegExp(node.pattern, "u");
            } catch (e) {
                problems.push(`${at}: invalid pattern ${node.pattern}: ${(e as Error).message}`);
            }
        }
        if (node.defaultSnippets !== undefined) {
            if (!Array.isArray(node.defaultSnippets) || node.defaultSnippets.some((s: any) => !isObj(s) || !("body" in s))) {
                problems.push(`${at}: defaultSnippets must be an array of {label?, body}`);
            }
        }
        if (typeof node.$ref === "string") {
            const [file, frag = ""] = node.$ref.split("#");
            let target: any;
            if (file) target = load ? resolvePointer(load(file), frag) : true;
            else target = resolvePointer(root, frag);
            if (target === undefined) problems.push(`${at}: unresolved $ref ${node.$ref}`);
        }
        for (const k of SCHEMA_MAPS) {
            if (node[k] === undefined) continue;
            if (!isObj(node[k])) problems.push(`${at}: ${k} must be an object`);
            else for (const [name, sub] of Object.entries(node[k])) {
                if (k === "patternProperties") {
                    try {
                        new RegExp(name, "u");
                    } catch {
                        problems.push(`${at}: invalid patternProperties regex ${name}`);
                    }
                }
                visit(sub, `${at}/${k}/${name}`);
            }
        }
        for (const k of SCHEMA_SINGLE) if (node[k] !== undefined) visit(node[k], `${at}/${k}`);
        for (const k of SCHEMA_ARRAYS) {
            if (node[k] === undefined) continue;
            if (!Array.isArray(node[k]) || node[k].length === 0) problems.push(`${at}: ${k} must be a non-empty array`);
            else node[k].forEach((s: any, i: number) => visit(s, `${at}/${k}/${i}`));
        }
        if (node.items !== undefined) {
            if (Array.isArray(node.items)) node.items.forEach((s: any, i: number) => visit(s, `${at}/items/${i}`));
            else visit(node.items, `${at}/items`);
        }
    };
    visit(schema, "#");
    return problems;
}

function typeOf(v: unknown): string {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
    return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export class Validator {
    constructor(private readonly load: SchemaLoader) {}

    validate(schema: Schema, value: unknown): ValidationError[] {
        const errors: ValidationError[] = [];
        this.check(schema, schema, value, "", errors);
        return errors;
    }

    private resolve(root: Schema, ref: string): { root: Schema; node: Schema } {
        const [file, frag = ""] = ref.split("#");
        const r = file ? this.load(file) : root;
        const node = resolvePointer(r, frag);
        if (node === undefined) throw new Error(`unresolved $ref ${ref}`);
        return { root: r, node };
    }

    private check(root: Schema, schema: Schema, v: any, path: string, errors: ValidationError[]): void {
        const err = (message: string): void => {
            errors.push({ path: path || "/", message });
        };
        if (schema === true) return;
        if (schema === false) return err("no value is allowed here");
        const s = schema as Record<string, any>;

        if (typeof s.$ref === "string") {
            const r = this.resolve(root, s.$ref);
            this.check(r.root, r.node, v, path, errors);
            return; // draft-07: siblings of $ref are ignored
        }
        const t = typeOf(v);
        if (s.type !== undefined) {
            const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
            const ok = types.some((x) => x === t || (x === "number" && t === "integer"));
            if (!ok) return err(`expected ${types.join("|")}, got ${t}`);
        }
        if (s.enum && !s.enum.some((e: unknown) => deepEqual(e, v))) err(`must be one of ${JSON.stringify(s.enum)}`);
        if ("const" in s && !deepEqual(s.const, v)) err(`must equal ${JSON.stringify(s.const)}`);

        if (t === "integer" || t === "number") {
            if (s.minimum !== undefined && v < s.minimum) err(`must be >= ${s.minimum}`);
            if (s.maximum !== undefined && v > s.maximum) err(`must be <= ${s.maximum}`);
            if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) err(`must be > ${s.exclusiveMinimum}`);
            if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) err(`must be < ${s.exclusiveMaximum}`);
        }
        if (t === "string") {
            if (s.minLength !== undefined && [...v].length < s.minLength) err(`must have length >= ${s.minLength}`);
            if (s.maxLength !== undefined && [...v].length > s.maxLength) err(`must have length <= ${s.maxLength}`);
            if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(v)) err(`must match ${s.pattern}`);
        }
        if (t === "array") {
            if (s.minItems !== undefined && v.length < s.minItems) err(`must have >= ${s.minItems} items`);
            if (s.maxItems !== undefined && v.length > s.maxItems) err(`must have <= ${s.maxItems} items`);
            if (s.uniqueItems) {
                const seen = new Set(v.map((x: unknown) => JSON.stringify(x)));
                if (seen.size !== v.length) err("items must be unique");
            }
            if (Array.isArray(s.items)) {
                v.forEach((item: unknown, i: number) => {
                    if (i < s.items.length) this.check(root, s.items[i], item, `${path}/${i}`, errors);
                    else if (s.additionalItems !== undefined) this.check(root, s.additionalItems, item, `${path}/${i}`, errors);
                });
            } else if (s.items !== undefined) {
                v.forEach((item: unknown, i: number) => this.check(root, s.items, item, `${path}/${i}`, errors));
            }
        }
        if (t === "object") {
            const keys = Object.keys(v);
            if (s.required) for (const k of s.required) if (!(k in v)) err(`missing required property ${JSON.stringify(k)}`);
            if (s.minProperties !== undefined && keys.length < s.minProperties) err(`must have >= ${s.minProperties} properties`);
            if (s.maxProperties !== undefined && keys.length > s.maxProperties) err(`must have <= ${s.maxProperties} properties`);
            for (const k of keys) {
                const sub = `${path}/${k}`;
                if (s.propertyNames !== undefined) {
                    const before = errors.length;
                    this.check(root, s.propertyNames, k, sub, errors);
                    if (errors.length > before) errors.splice(before, errors.length - before, { path: sub, message: `invalid property name ${JSON.stringify(k)}` });
                }
                let matched = false;
                if (s.properties && Object.prototype.hasOwnProperty.call(s.properties, k)) {
                    matched = true;
                    this.check(root, s.properties[k], v[k], sub, errors);
                }
                for (const [re, ps] of Object.entries<Schema>(s.patternProperties ?? {})) {
                    if (new RegExp(re, "u").test(k)) {
                        matched = true;
                        this.check(root, ps, v[k], sub, errors);
                    }
                }
                if (!matched && s.additionalProperties !== undefined) {
                    if (s.additionalProperties === false) errors.push({ path: sub, message: `property ${JSON.stringify(k)} is not allowed` });
                    else this.check(root, s.additionalProperties, v[k], sub, errors);
                }
            }
        }
        const passes = (sub: Schema) => {
            const tmp: ValidationError[] = [];
            this.check(root, sub, v, path, tmp);
            return tmp.length === 0;
        };
        if (s.allOf) for (const sub of s.allOf) this.check(root, sub, v, path, errors);
        if (s.anyOf && !s.anyOf.some(passes)) err(s.errorMessage ?? "must match at least one schema of anyOf");
        if (s.oneOf && s.oneOf.filter(passes).length !== 1) err(s.errorMessage ?? "must match exactly one schema of oneOf");
        if (s.not !== undefined && passes(s.not)) err(s.errorMessage ?? "matches a schema that is not allowed");
        if (s.if !== undefined) {
            if (passes(s.if)) {
                if (s.then !== undefined) this.check(root, s.then, v, path, errors);
            } else if (s.else !== undefined) this.check(root, s.else, v, path, errors);
        }
    }
}
