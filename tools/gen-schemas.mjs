#!/usr/bin/env node
// Generates JSON Schemas (draft-07) for VoxelCore content-pack files.
//
//   node tools/gen-schemas.mjs [--check]
//
// Sources of truth (combined):
//   1. engine C++ (VOXELCORE_ROOT or `..`): enum metadata (VC_ENUM_METADATA),
//      literal enums, and the keys every loader reads (completeness check:
//      the run FAILS if a loader reads a key the schema doesn't declare);
//   2. doc/en/*.md: property descriptions, enum descriptions, defaults;
//   3. tools/schema-overlay/*.mjs: hand-maintained types and shapes.
//
// Outputs: schemas/*.schema.json, schemas/catalog.json, contrib/schemas.json.
// With --check nothing is written; the run fails if outputs are stale.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.VOXELCORE_ROOT ?? path.join(EXT, ".."));
const OVERLAY_DIR = path.join(EXT, "tools", "schema-overlay");
const OUT_DIR = path.join(EXT, "schemas");
const CONTRIB = path.join(EXT, "contrib", "schemas.json");
const GITHUB = "https://github.com/MihailRis/VoxelCore/blob/main/";
const DOC_DIR = "doc/en";
const CHECK_ONLY = process.argv.includes("--check");

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

// ---------------------------------------------------------------- engine src

const srcCache = new Map();
function readRoot(rel) {
    if (!srcCache.has(rel)) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) throw new Error(`engine file not found: ${rel} (engine root: ${ROOT})`);
        srcCache.set(rel, fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n"));
    }
    return srcCache.get(rel);
}

function walkFiles(dir, filter, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkFiles(p, filter, out);
        else if (filter(p)) out.push(p);
    }
    return out;
}

/** VC_ENUM_METADATA(Name) {"a", ...}, ... VC_ENUM_END → { Name: ["a", ...] } */
function collectEnums() {
    const enums = {};
    for (const file of walkFiles(path.join(ROOT, "src"), (p) => /\.(hpp|h|cpp)$/.test(p))) {
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes("VC_ENUM_METADATA(")) continue;
        const re = /VC_ENUM_METADATA\((\w+)\)([\s\S]*?)VC_ENUM_END/g;
        let m;
        while ((m = re.exec(text))) {
            if (m[1] === "NAME") continue; // the macro definition itself
            enums[m[1]] = [...m[2].matchAll(/\{\s*"([^"]*)"/g)].map((x) => x[1]);
        }
    }
    return enums;
}

function regexEnum({ file, regex, extra = [] }) {
    const values = [...readRoot(file).matchAll(new RegExp(regex, "g"))].map((m) => m[1]);
    if (!values.length) fail(`x-enum-regex /${regex}/ matched nothing in ${file}`);
    return [...new Set([...extra, ...values])];
}

/** Body of the function whose definition contains `marker` (or the whole file). */
function functionBody(file, marker) {
    const text = readRoot(file);
    if (!marker) return text;
    let from = 0;
    for (;;) {
        const idx = text.indexOf(marker, from);
        if (idx < 0) {
            fail(`${file}: function marker ${JSON.stringify(marker)} not found (loader changed?)`);
            return "";
        }
        let i = text.indexOf("(", idx + marker.length - (marker.endsWith("(") || marker.endsWith("(\n") ? 2 : 0));
        let depth = 0;
        for (; i < text.length; i++) {
            if (text[i] === "(") depth++;
            else if (text[i] === ")" && --depth === 0) break;
        }
        const brace = text.indexOf("{", i);
        const semi = text.indexOf(";", i);
        if (brace < 0 || (semi >= 0 && semi < brace)) {
            from = idx + marker.length; // a declaration or a call: keep looking
            continue;
        }
        depth = 0;
        for (let j = brace; j < text.length; j++) {
            const c = text[j];
            if (c === '"') {
                for (j++; j < text.length && text[j] !== '"'; j++) if (text[j] === "\\") j++;
            } else if (c === "/" && text[j + 1] === "/") {
                j = text.indexOf("\n", j);
            } else if (c === "{") depth++;
            else if (c === "}" && --depth === 0) return text.slice(brace, j + 1);
        }
        return text.slice(brace);
    }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** String keys read from `recv` objects in `body`. */
function extractKeys(body, recv) {
    const keys = new Set();
    for (const r of recv) {
        const R = escapeRe(r);
        const patterns = [
            new RegExp(`(?<![\\w.])${R}\\s*\\.\\s*(?:at|has)\\s*\\(\\s*"([^"]*)"`, "g"),
            new RegExp(`(?<![\\w.])${R}\\s*\\[\\s*"([^"]*)"\\s*\\]`, "g"),
            new RegExp(`dv::get(?:_vec|_mat)?\\s*\\(\\s*${R}\\s*,\\s*"([^"]*)"`, "g"),
        ];
        for (const re of patterns) for (const m of body.matchAll(re)) keys.add(m[1]);
    }
    return keys;
}

// --------------------------------------------------------------------- docs

const docCache = new Map();

function slugify(title) {
    return title
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
}

function cleanKey(s) {
    return s.trim().replace(/^[*`'"\\]+|[*`'"\\]+$/g, "").trim();
}

/** Keys named in a heading title: *x*, **x**, `x`. */
function titleKeys(title) {
    const keys = [...title.matchAll(/\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`/g)].map((m) =>
        cleanKey(m[1] ?? m[2] ?? m[3])
    );
    return keys.length ? keys : [cleanKey(title)];
}

function loadDoc(rel) {
    if (docCache.has(rel)) return docCache.get(rel);
    const file = `${DOC_DIR}/${rel}`;
    const lines = readRoot(file).split("\n");
    const sections = [];
    const tables = [];
    let fence = false;
    const headingAt = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        if (fence) continue;
        const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (h) headingAt.push({ line: i, level: h[1].length, title: h[2] });
    }
    for (let k = 0; k < headingAt.length; k++) {
        const { line, level, title } = headingAt[k];
        let end = lines.length;
        let direct = lines.length;
        for (let n = k + 1; n < headingAt.length; n++) {
            if (direct === lines.length) direct = headingAt[n].line;
            if (headingAt[n].level <= level) {
                end = headingAt[n].line;
                break;
            }
        }
        sections.push({
            level,
            title,
            keys: titleKeys(title),
            slug: slugify(title),
            start: line + 1,
            end,
            direct,
            body: lines.slice(line + 1, end).join("\n").trim(),
        });
    }
    // tables (outside code fences)
    fence = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
        if (fence) continue;
        if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
            const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
            const header = cells(lines[i]);
            const rows = [];
            let j = i + 2;
            for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) rows.push(cells(lines[j]));
            const section = [...sections].reverse().find((s) => s.start <= i && i < s.end);
            tables.push({ line: i, header, rows, section });
            i = j;
        }
    }
    const doc = { rel, file, url: GITHUB + file, lines, sections, tables };
    docCache.set(rel, doc);
    return doc;
}

function findSection(doc, name) {
    return (
        doc.sections.find((s) => s.title === name) ??
        doc.sections.find((s) => s.keys.includes(name)) ??
        doc.sections.find((s) => cleanKey(s.title.replace(/\*/g, "")) === name)
    );
}

/** List items of a markdown block: [{key(s), path, text, depth}] */
function parseList(text) {
    const items = [];
    const stack = [];
    let fence = false;
    let current = null;
    for (const line of text.split("\n")) {
        if (/^\s*(```|~~~)/.test(line)) fence = !fence;
        if (fence) {
            if (current) current.extra.push(line);
            continue;
        }
        const m = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
        if (!m) {
            if (current && /^\s+\S/.test(line)) current.extra.push(line.trim());
            else if (!line.trim()) current = null;
            continue;
        }
        const indent = m[1].replace(/\t/g, "    ").length;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const body = m[2];
        const sep = body.search(/\s[-–—]\s/);
        let keys = [];
        let desc = body;
        if (sep > 0) {
            const head = body.slice(0, sep);
            const named = [...head.matchAll(/\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|"([^"]+)"|'([^']+)'/g)].map((x) =>
                cleanKey(x[1] ?? x[2] ?? x[3] ?? x[4] ?? x[5])
            );
            keys = named.length ? named : /^[\w.@:-]+$/.test(head.trim()) ? [head.trim()] : [];
            desc = body.slice(sep).replace(/^\s[-–—]\s/, "");
        } else {
            const only = /^(?:\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|([\w.@:-]+))\s*(?:\(.*\))?\s*$/.exec(body.trim());
            if (only) keys = [cleanKey(only[1] ?? only[2] ?? only[3] ?? only[4])];
            desc = "";
        }
        const parentPath = stack.length ? stack[stack.length - 1].path : "";
        const item = { keys, depth: stack.length, parentPath, text: desc, extra: [], indent };
        item.path = keys.length ? (parentPath ? `${parentPath}.${keys[0]}` : keys[0]) : parentPath;
        items.push(item);
        stack.push(item);
        current = item;
    }
    return items.map((it) => ({ ...it, text: [it.text, ...it.extra].join("\n").trim() }));
}

/** Rewrites relative links/images to absolute GitHub URLs, converts callouts. */
function polishMarkdown(md, doc) {
    const base = path.posix.dirname(doc.file);
    md = md.replace(/(!?\[[^\]]*\])\(([^)\s]+)\)/g, (all, label, target) => {
        if (/^[a-z]+:/i.test(target)) return all;
        if (target.startsWith("#")) return `${label}(${doc.url}${target})`;
        const [p, hash] = target.split("#");
        const resolved = p.startsWith("/") ? p.slice(1) : path.posix.normalize(path.posix.join(base, p));
        return `${label}(${GITHUB}${resolved}${hash ? "#" + hash : ""})`;
    });
    md = md.replace(/^>\s*\[!(\w+)\]\s*\n((?:>.*\n?)*)/gm, (all, kind, rest) => {
        const text = rest.replace(/^>\s?/gm, "").trim();
        return `> **${kind[0] + kind.slice(1).toLowerCase()}:** ${text}\n`;
    });
    md = md.replace(/\n{3,}/g, "\n\n").trim();
    // close an unterminated code fence (doc/en/block-properties.md ends with "``")
    if ((md.match(/^\s*```/gm) ?? []).length % 2) md = md.replace(/\n``?\s*$/, "") + "\n```";
    return md;
}

function toPlain(md) {
    return md
        .replace(/```[a-z]*\n?/gi, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1$2")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/^>\s?/gm, "")
        .replace(/^#+\s*/gm, "")
        .replace(/\\([[\]*_])/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function parseDocDefault(cell) {
    if (cell === undefined) return undefined;
    const c = cell.replace(/[`*]/g, "").trim();
    if (c === "" || c === "-") return undefined;
    if (c === "true" || c === "false") return c === "true";
    if (c === '""') return "";
    if (/^-?\d+(\.\d+)?$/.test(c)) return Number(c);
    const vec = /^\{([^}]*)\}$/.exec(c);
    if (vec) return vec[1].trim() ? vec[1].split(",").map((x) => Number(x.trim())) : undefined;
    return c;
}

/**
 * Looks up documentation for `key` in the doc sources.
 * Returns { md, url, default?, enumDocs: Map } or undefined.
 */
function lookupDoc(key, sources) {
    for (const src of sources ?? []) {
        const doc = loadDoc(src.file);
        const scope = src.section ? findSection(doc, src.section) : null;
        if (src.section && !scope) {
            fail(`${DOC_DIR}/${src.file}: section ${JSON.stringify(src.section)} not found`);
            continue;
        }
        const mode = src.mode ?? "headings";
        if (mode === "headings") {
            let sec;
            if (src.fixed) sec = scope;
            else if (scope) sec = doc.sections.find((x) => x.start >= scope.start - 1 && x.end <= scope.end && x.keys.includes(key));
            else sec = doc.sections.find((x) => x.keys.includes(key));
            if (!sec) continue;
            return {
                md: polishMarkdown(sec.body, doc),
                url: `${doc.url}#${sec.slug}`,
                enumDocs: enumDocsFromList(sec.body, doc),
            };
        }
        if (mode === "table") {
            let tables = doc.tables;
            if (scope) tables = tables.filter((t) => t.line >= scope.start && t.line < scope.end);
            if (src.table !== undefined) tables = tables.slice(src.table, src.table + 1);
            for (const t of tables) {
                const row = t.rows.find((r) => cleanKey(r[0]) === (src.key ?? key));
                if (!row) continue;
                const di = t.header.findIndex((h) => /default/i.test(h));
                return {
                    md: polishMarkdown(row[1] ?? "", doc),
                    url: t.section ? `${doc.url}#${t.section.slug}` : doc.url,
                    default: di >= 0 ? parseDocDefault(row[di]) : undefined,
                    enumDocs: new Map(),
                };
            }
            continue;
        }
        if (mode === "list") {
            const text = scope ? scope.body : doc.lines.join("\n");
            const items = parseList(text);
            const item = items.find((it) => it.parentPath === (src.prefix ?? "") && it.keys.includes(key));
            if (!item) continue;
            const children = items.filter((it) => it.parentPath === item.path && it.keys.length);
            let md = item.text;
            if (children.length) md += "\n\n" + children.map((c) => `- \`${c.keys.join("`, `")}\` - ${c.text}`).join("\n");
            const def = /Default:\s*([^.\s]+(?:\.\d+)?)/.exec(item.text);
            return {
                md: polishMarkdown(md, doc),
                url: scope ? `${doc.url}#${scope.slug}` : doc.url,
                default: def ? parseDocDefault(def[1]) : undefined,
                enumDocs: new Map(),
            };
        }
        fail(`unknown doc mode ${mode}`);
    }
    return undefined;
}

function enumDocsFromList(text, doc) {
    const map = new Map();
    for (const it of parseList(text)) {
        if (it.depth === 0 && it.keys.length === 1 && it.text) map.set(it.keys[0], polishMarkdown(it.text, doc));
    }
    return map;
}

function enumDocsFrom(src) {
    const doc = loadDoc(src.file);
    if (src.mode === "table") {
        const t = doc.tables[src.table ?? 0];
        return new Map(t.rows.map((r) => [cleanKey(r[0]), polishMarkdown(r[1] ?? "", doc)]));
    }
    const scope = src.section ? findSection(doc, src.section) : null;
    if (src.section && !scope) fail(`${DOC_DIR}/${src.file}: section ${JSON.stringify(src.section)} not found`);
    return enumDocsFromList(scope ? scope.body : doc.lines.join("\n"), doc);
}

// ----------------------------------------------------------------- building

const enums = collectEnums();
const reservedIds = [
    ...readRoot("src/content/ContentPack.cpp")
        .match(/RESERVED_NAMES\s*=\s*\{([\s\S]*?)\};/)[1]
        .matchAll(/"([^"]+)"/g),
].map((m) => m[1]);
if (!reservedIds.includes("none")) reservedIds.push("none"); // checkContentPackId: "id is not specified"

function bindingCodes() {
    const input = readRoot("src/window/input.cpp");
    const table = (name) => {
        const m = new RegExp(`${name}\\s*\\{([\\s\\S]*?)\\};`).exec(input);
        return m ? [...m[1].matchAll(/\{"([^"]+)"/g)].map((x) => x[1]) : [];
    };
    const keys = table("unordered_map<std::string, int> keycodes");
    const mouse = table("unordered_map<std::string, int> mousecodes");
    // generated in input_util::initialize()
    if (!/keycodes\[std::to_string\(i\)\] = GLFW_KEY_0/.test(input)) fail("input.cpp: digit keycodes loop changed");
    for (let i = 0; i <= 9; i++) keys.push(String(i));
    const fCount = Number(/for \(int i = 0; i < (\d+); i\+\+\) \{\s*keycodes\["f"/.exec(input)?.[1] ?? 0);
    if (!fCount) fail("input.cpp: function keys loop changed");
    for (let i = 1; i <= fCount; i++) keys.push(`f${i}`);
    for (let c = 97; c <= 122; c++) keys.push(String.fromCharCode(c));
    for (let i = 0; i <= 9; i++) keys.push(`num-${i}`);
    if (keys.length < 50 || mouse.length < 3) fail("input.cpp: could not read keycodes/mousecodes tables");
    return [...keys.map((k) => `key:${k}`), ...mouse.map((k) => `mouse:${k}`)];
}

const postContentNames = (() => {
    const lua = readRoot("res/scripts/post_content.lua");
    const m = /local names = \{([\s\S]*?)\n\}/.exec(lua);
    if (!m) {
        fail("res/scripts/post_content.lua: `local names = {...}` not found");
        return [];
    }
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
})();
// set by the engine itself, not meant to be written in definitions
const INTERNAL_PROPS = new Set(["name", "script-file"]);

const USER_PROP = "^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_.-]+$";
const USER_PROP_APPEND = "^[A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_.-]+@append$";

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function formatDefault(v) {
    return "`" + JSON.stringify(v).replace(/,/g, ", ") + "`";
}

class SchemaBuilder {
    constructor(overlay) {
        this.ov = overlay;
        this.name = overlay.file;
        this.luaLib = overlay.luaProperties;
    }

    build() {
        const s = this.ov.schema;
        const out = this.node(s, this.ov.docs ?? [], "");
        const root = {
            $schema: "http://json-schema.org/draft-07/schema#",
            $id: `${GITHUB}vscode-extension/schemas/${this.ov.file}`,
            title: this.ov.title,
            description: toPlain(this.ov.description),
            markdownDescription: this.ov.description,
            ...out,
        };
        return root;
    }

    /** Builds a schema node (recursively). `docs` = doc sources for child properties. */
    node(src, docs, where, rule = false) {
        if (!isObj(src)) return src;
        const n = {};
        for (const [k, v] of Object.entries(src)) if (v !== undefined) n[k] = v;

        if (n["x-enum"]) {
            const values = enums[n["x-enum"]];
            if (!values) fail(`${this.name}${where}: unknown enum ${n["x-enum"]}`);
            else n.enum = values;
        }
        if (n["x-enum-regex"]) n.enum = regexEnum(n["x-enum-regex"]);
        if (n["x-binding-codes"]) n.enum = bindingCodes();
        if (n["x-reserved-ids"]) n.not = { enum: reservedIds };
        if (n["x-resource-types"]) {
            const types = enums.ResourceType;
            if (!types) fail("ResourceType enum metadata not found");
            n.properties = {};
            for (const t of types ?? []) {
                n.properties[t] = clone(n["x-resource-types"]);
                const md = n["x-resource-docs"]?.[t];
                if (md) n.properties[t]["x-md"] = md;
                else fail(`${this.name}: no x-resource-docs entry for resource type ${t}`);
            }
            delete n["x-resource-types"];
        }
        if (n["x-enum-docs"] && n.enum) n["x-enum-docs-map"] = enumDocsFrom(n["x-enum-docs"]);

        const childDocs = n["x-docs"] ?? docs;
        if (isObj(n.definitions)) {
            const defs = {};
            for (const [k, v] of Object.entries(n.definitions)) {
                defs[k] = this.node(v, v["x-docs"] ?? childDocs, `${where}/definitions/${k}`);
                this.describe(defs[k], v["x-doc"] ? k : null, v, v["x-docs"] ?? childDocs);
            }
            n.definitions = defs;
        }
        if (isObj(n.properties)) {
            const props = {};
            for (const [k, v] of Object.entries(n.properties)) {
                props[k] = this.node(v, childDocs, `${where}/properties/${k}`, rule);
                if (!rule) this.describe(props[k], k, v, childDocs, where === "");
            }
            n.properties = props;
        }
        const RULES = ["not", "if", "then", "else", "propertyNames"];
        for (const key of ["items", "additionalProperties", "additionalItems", ...RULES]) {
            const r = rule || RULES.includes(key);
            if (Array.isArray(n[key])) n[key] = n[key].map((x, i) => this.node(x, childDocs, `${where}/${key}/${i}`, r));
            else if (isObj(n[key])) n[key] = this.node(n[key], childDocs, `${where}/${key}`, r);
        }
        for (const key of ["anyOf", "oneOf", "allOf"]) {
            if (Array.isArray(n[key])) n[key] = n[key].map((x, i) => this.node(x, childDocs, `${where}/${key}/${i}`, rule));
        }
        if (isObj(n.patternProperties)) {
            for (const [k, v] of Object.entries(n.patternProperties)) n.patternProperties[k] = this.node(v, childDocs, where);
        }

        // rule nodes: x-md becomes the validation error message
        if (n["x-md"] && (n.not || n.if) && !n.properties && !n.type) {
            const msg = toPlain(n["x-md"]);
            if (n.if && isObj(n.then)) n.then.errorMessage ??= msg;
            else n.errorMessage ??= msg;
            delete n["x-md"];
        }
        if (n["x-reserved-ids"]) {
            n.errorMessage = `This pack id is reserved: ${reservedIds.join(", ")}.`;
            n.patternErrorMessage =
                "Pack id: letters, digits and _, not starting with a digit, 2..24 characters.";
        }
        if (n["x-md"] && !n.markdownDescription) {
            // generic fallback; describe() may override with docs
            n.markdownDescription = n["x-md"];
        }
        if (n.markdownDescription && !n.description) n.description = toPlain(n.markdownDescription);

        if (n["x-append"] && n.properties) this.addAppendMethods(n);
        if (n["x-user-props"]) {
            n.patternProperties = {
                [USER_PROP]: {
                    description:
                        "User property (pack:name). It must be declared in some pack's config/user-props.toml, " +
                        "otherwise it is removed from the Lua properties table.",
                    markdownDescription:
                        "User property (`pack:name`). It must be declared in some pack's " +
                        "`config/user-props.toml`, otherwise `res/scripts/post_content.lua` removes it from the " +
                        "Lua `properties` table. Accessed as `block.properties[id][\"pack:name\"]`.",
                },
                [USER_PROP_APPEND]: {
                    description: "Appends to a list-valued user property (method @append).",
                },
            };
        }
        if (n.type === "object" && n.properties && n.additionalProperties === undefined) {
            n.additionalProperties = false;
        }
        delete n["x-docs"];
        return n;
    }

    resolveLocal(schemaRoot, node) {
        let cur = node;
        for (let guard = 0; cur && cur.$ref && guard < 10; guard++) {
            if (!cur.$ref.startsWith("#/")) return cur;
            cur = cur.$ref
                .slice(2)
                .split("/")
                .reduce((o, k) => (o ? o[k] : undefined), schemaRoot);
        }
        return cur;
    }

    addAppendMethods(n) {
        const lib = this.luaLib ?? "block";
        for (const [k, v] of Object.entries(n.properties)) {
            if (k.includes("@") || k.includes(":")) continue;
            const r = this.resolveLocal({ definitions: n.definitions }, v);
            if (!r || r.type !== "array") continue;
            const item = Array.isArray(r.items) ? {} : (r.items ?? {});
            n.properties[`${k}@append`] = {
                anyOf: [clone(item), { type: "array", items: clone(item) }],
                markdownDescription:
                    `Method \`@append\`: appends the value(s) to the list \`${k}\` of a previous definition of ` +
                    `this ${lib} (e.g. from another pack) instead of replacing it. It affects the Lua-side ` +
                    `\`${lib}.properties\` table; the engine itself reads \`${k}\` directly.`,
                description: `Method @append: appends the value(s) to the list "${k}" of a previous definition.`,
                "x-virtual": true,
            };
        }
    }

    /** Adds markdownDescription/description/default/enum docs to a built property. */
    describe(built, key, src, docs, isRootProp = false) {
        if (!isObj(built) || !isObj(src)) return;
        const xdoc = src["x-doc"];
        let found;
        if (typeof xdoc === "string") found = lookupDoc(xdoc, docs);
        else if (isObj(xdoc)) found = lookupDoc(xdoc.key ?? key ?? "", [{ ...xdoc, fixed: xdoc.mode !== "table" && xdoc.mode !== "list" }]);
        else if (key) found = lookupDoc(key, docs);

        let md = src.markdownDescription ?? found?.md ?? src["x-md"];
        if (!md && !src.description && key && !key.includes("@")) {
            warn(`${this.name}: no documentation for ${JSON.stringify(key)}`);
        }
        if (found?.default !== undefined) {
            if (built.default === undefined) built.default = found.default;
            else if (JSON.stringify(found.default) !== JSON.stringify(built.default)) {
                warn(
                    `${this.name}: doc default for ${JSON.stringify(key)} is ${JSON.stringify(found.default)}, ` +
                        `engine default is ${JSON.stringify(built.default)} (schema uses the engine value)`
                );
            }
        }
        if (md !== undefined) {
            const extra = [];
            if (src["x-note"]) extra.push(src["x-note"]);
            if (built.default !== undefined && !/default/i.test(`${md}\n${src["x-note"] ?? ""}`)) {
                extra.push(`Default: ${formatDefault(built.default)}.`);
            }
            if (this.luaLib && key && isRootProp && !postContentNames.includes(key) && !key.includes(":") && !key.includes("@")) {
                extra.push(
                    `_Not available in \`${this.luaLib}.properties\` (removed by \`res/scripts/post_content.lua\`)._`
                );
            }
            if (found?.url) extra.push(`[Documentation](${found.url})`);
            built.markdownDescription = [md, ...extra].filter(Boolean).join("\n\n");
            built.description = toPlain([md, ...extra.slice(0, found?.url ? -1 : undefined)].join("\n\n"));
        }
        // enum descriptions
        if (Array.isArray(built.enum)) {
            const map = built["x-enum-docs-map"] ?? found?.enumDocs;
            if (map && map.size) {
                const descs = built.enum.map((v) => map.get(v) ?? "");
                if (descs.some(Boolean)) {
                    built.markdownEnumDescriptions = descs;
                    built.enumDescriptions = descs.map(toPlain);
                }
                for (const v of map.keys()) {
                    if (!built.enum.includes(v) && /^[\w-]+$/.test(v) && found?.enumDocs === map) {
                        warn(`${this.name}: ${key}: documented value ${JSON.stringify(v)} is not accepted by the engine`);
                    }
                }
                for (const v of built.enum) {
                    if (!map.has(v)) warn(`${this.name}: ${key}: engine value ${JSON.stringify(v)} is undocumented`);
                }
            }
            delete built["x-enum-docs-map"];
        }
    }
}

// ------------------------------------------------------------------- checks

function pointer(schema, ptr) {
    if (ptr === "") return schema;
    return ptr
        .split("/")
        .slice(1)
        .reduce((o, k) => (o === undefined ? undefined : o[k.replace(/~1/g, "/").replace(/~0/g, "~")]), schema);
}

function objectAt(schema, ptr) {
    let node = pointer(schema, ptr);
    for (let i = 0; node && node.$ref && i < 10; i++) node = pointer(schema, node.$ref.slice(1));
    return node;
}

function checkExtraction(ov, schema) {
    const usedByTarget = new Map();
    for (const spec of ov.extract ?? []) {
        const keys = extractKeys(functionBody(spec.file, spec.func), spec.recv);
        if (!keys.size && spec.func) warn(`${ov.file}: no keys extracted from ${spec.file} ${spec.func ?? ""}`);
        for (const ptr of spec.in) {
            if (!usedByTarget.has(ptr)) usedByTarget.set(ptr, new Set());
            for (const k of keys) usedByTarget.get(ptr).add(k);
        }
        for (const key of keys) {
            if (spec.ignore?.includes(key)) continue;
            const hits = spec.in.map((ptr) => {
                const obj = objectAt(schema, ptr);
                if (!obj) {
                    fail(`${ov.file}: extraction target ${JSON.stringify(ptr)} does not exist in the schema`);
                    return false;
                }
                return !!obj.properties?.[key];
            });
            const ok = spec.any ? hits.some(Boolean) : hits.every(Boolean);
            if (!ok) {
                fail(
                    `${ov.file}: key ${JSON.stringify(key)} is read by ${spec.file}` +
                        `${spec.func ? ` (${spec.func.trim()})` : ""} but is missing from the schema at ` +
                        spec.in.map((p) => JSON.stringify(p || "#")).join(spec.any ? " or " : " and ") +
                        " — add it to tools/schema-overlay/"
                );
            }
        }
    }
    // overlay keys no loader reads
    for (const [ptr, used] of usedByTarget) {
        const obj = objectAt(schema, ptr);
        for (const [k, v] of Object.entries(obj?.properties ?? {})) {
            if (!used.has(k) && !v["x-virtual"] && !k.includes("@")) {
                const readElsewhere = [...usedByTarget.values()].some((s) => s.has(k));
                if (!readElsewhere) warn(`${ov.file}: ${ptr || "#"}/${k} is in the overlay but no extracted loader code reads it`);
            }
        }
    }
}

function checkLuaNames(schemas) {
    const known = new Set();
    for (const s of schemas) for (const k of Object.keys(s.properties ?? {})) known.add(k);
    for (const name of postContentNames) {
        if (INTERNAL_PROPS.has(name)) continue;
        if (!known.has(name)) {
            fail(`res/scripts/post_content.lua lists property ${JSON.stringify(name)} which is in neither block nor item schema`);
        }
    }
}

// ------------------------------------------------------- refs, cleanup, I/O

/** Inlines cross-file refs ("x.schema.json") as local definitions. */
function inlineRefs(schema, all) {
    const embedded = new Map();
    const visit = (node) => {
        if (Array.isArray(node)) return node.forEach(visit);
        if (!isObj(node)) return;
        if (typeof node.$ref === "string" && /^[\w.-]+\.schema\.json$/.test(node.$ref)) {
            const file = node.$ref;
            const target = all.get(file);
            if (!target) {
                fail(`${schema.$id}: $ref to unknown schema ${file}`);
                return;
            }
            const name = file.replace(/\.schema\.json$/, "");
            if (!embedded.has(file)) {
                const copy = clone(target);
                delete copy.$schema;
                delete copy.$id;
                const rewrite = (n) => {
                    if (Array.isArray(n)) return n.forEach(rewrite);
                    if (!isObj(n)) return;
                    if (typeof n.$ref === "string" && n.$ref.startsWith("#")) {
                        n.$ref = `#/definitions/${name}` + n.$ref.slice(1);
                    }
                    Object.values(n).forEach(rewrite);
                };
                rewrite(copy);
                embedded.set(file, copy);
            }
            node.$ref = `#/definitions/${name}`;
            return;
        }
        Object.values(node).forEach(visit);
    };
    visit(schema);
    if (embedded.size) {
        schema.definitions ??= {};
        for (const [file, copy] of embedded) schema.definitions[file.replace(/\.schema\.json$/, "")] = copy;
    }
}

function stripExtensions(node) {
    if (Array.isArray(node)) return node.map(stripExtensions);
    if (!isObj(node)) return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("x-")) continue;
        // `properties`/`definitions` maps: keys are names, not keywords
        out[k] = stripExtensions(v);
    }
    return out;
}

function globToRegex(glob) {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") {
            re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
            i += glob[i + 2] === "/" ? 2 : 1;
        } else if (c === "*") re += "[^/]*";
        else if (c === "?") re += "[^/]";
        else re += escapeRe(c);
    }
    return `^(?:.*/)?${re.replace(/^\(\?:\.\*\/\)\?/, "")}$`;
}

async function loadOverlays() {
    const files = fs
        .readdirSync(OVERLAY_DIR)
        .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
        .sort();
    const list = [];
    for (const f of files) {
        const mod = await import(pathToFileURL(path.join(OVERLAY_DIR, f)).href);
        const def = mod.default;
        for (const ov of Array.isArray(def) ? def : [def]) list.push(ov);
    }
    return list;
}

function writeOut(file, data, stale) {
    const text = JSON.stringify(data, null, 2) + "\n";
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (old === text) return;
    if (CHECK_ONLY) stale.push(path.relative(EXT, file));
    else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
}

async function main() {
    if (!fs.existsSync(path.join(ROOT, "src", "content", "loading", "BlockLoader.cpp"))) {
        console.error(`gen-schemas: engine sources not found at ${ROOT} (set VOXELCORE_ROOT)`);
        process.exit(2);
    }
    const overlays = await loadOverlays();
    const built = new Map();
    for (const ov of overlays) {
        try {
            built.set(ov.file, new SchemaBuilder(ov).build());
        } catch (e) {
            fail(`${ov.file}: ${e.stack ?? e}`);
        }
    }
    for (const ov of overlays) if (built.has(ov.file)) checkExtraction(ov, built.get(ov.file));
    checkLuaNames(overlays.filter((o) => o.luaProperties).map((o) => built.get(o.file)).filter(Boolean));

    const final = new Map();
    for (const [file, schema] of built) {
        const copy = clone(schema);
        final.set(file, copy);
    }
    for (const [, schema] of final) inlineRefs(schema, built);

    for (const w of warnings) console.warn(`warning: ${w}`);
    if (errors.length) {
        for (const e of errors) console.error(`error: ${e}`);
        console.error(`gen-schemas: ${errors.length} error(s); nothing written.`);
        process.exit(1);
    }

    const stale = [];
    const catalog = [];
    const expected = new Set();
    for (const ov of overlays) {
        const schema = stripExtensions(final.get(ov.file));
        writeOut(path.join(OUT_DIR, ov.file), schema, stale);
        expected.add(ov.file);
        const entry = { schema: ov.file, title: ov.title, format: ov.format, fileMatch: ov.fileMatch };
        if (ov.format === "toml") entry.regexMatch = ov.fileMatch.map(globToRegex);
        if (!ov.fileMatch.length) entry.refOnly = true;
        catalog.push(entry);
    }
    writeOut(path.join(OUT_DIR, "catalog.json"), catalog, stale);
    expected.add("catalog.json");
    for (const f of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []) {
        if (f.endsWith(".json") && !expected.has(f)) {
            if (CHECK_ONLY) stale.push(`schemas/${f} (obsolete)`);
            else fs.rmSync(path.join(OUT_DIR, f));
        }
    }

    const EXCLUDE = ["!**/node_modules/**", "!**/.vscode/**"];
    const contrib = {
        contributes: {
            jsonValidation: catalog
                .filter((c) => c.format === "json" && c.fileMatch.length)
                .map((c) => ({ fileMatch: [...c.fileMatch, ...EXCLUDE], url: `./schemas/${c.schema}` })),
        },
    };
    writeOut(CONTRIB, contrib, stale);

    if (CHECK_ONLY && stale.length) {
        console.error(`gen-schemas --check: stale outputs:\n  ${stale.join("\n  ")}\nRun: node tools/gen-schemas.mjs`);
        process.exit(1);
    }
    console.log(
        `gen-schemas: ${overlays.length} schemas ${CHECK_ONLY ? "up to date" : "written"} ` +
            `(engine: ${ROOT}, ${warnings.length} warning(s))`
    );
}

await main();
