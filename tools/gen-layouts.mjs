#!/usr/bin/env node
// Generates the XML UI layout element data (FEATURES.md §3.7).
//
//   node tools/gen-layouts.mjs [--check]
//
// Sources of truth:
//   1. src/graphics/ui/gui_xml.cpp: the elements (`add("tag", reader)`), the
//      attributes each reader reads (following helper calls such as
//      read_uinode / read_panel_impl / register_action), their value types
//      (`asVec2`, `asColor`, ...), defaults, enum values, Lua callback kinds
//      (`scripting::create_*`) and whether inner text / sub-elements are read;
//   2. doc/en/xml-ui-layouts.md: descriptions (engine wins on facts).
//
// Outputs: shared/layouts/elements.json, and syntaxes/vclayout-lua.injection.json
// (Lua highlighting inside the callback attributes, injected into text.xml). The run FAILS when the engine reads
// something this script can't classify, so it can't silently fall behind.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(process.env.VOXELCORE_ROOT ?? path.join(EXT, ".."));
const OUT = path.join(EXT, "shared", "layouts", "elements.json");
const GRAMMAR = path.join(EXT, "syntaxes", "vclayout-lua.injection.json");
const SOURCE = "src/graphics/ui/gui_xml.cpp";
const DOC = "doc/en/xml-ui-layouts.md";
const CHECK_ONLY = process.argv.includes("--check");

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

// ------------------------------------------------------------ engine facts

/** `scripting::create_*` → how the attribute text is run (scripting_functional.cpp). */
const LUA_FACTORIES = {
    create_runnable: { kind: "chunk" },
    create_vec2_supplier: { kind: "expression", returns: "vec2" },
    create_wstring_supplier: { kind: "expression", returns: "string" },
    create_bool_supplier: { kind: "expression", returns: "boolean" },
    create_number_supplier: { kind: "expression", returns: "number" },
    create_bool_consumer: { kind: "expression", args: ["boolean"] },
    create_wstring_consumer: { kind: "expression", args: ["string"] },
    create_string_consumer: { kind: "expression", args: ["string"] },
    create_number_consumer: { kind: "expression", args: ["number"] },
    create_wstring_validator: { kind: "expression", args: ["string"], returns: "boolean" },
    create_key_handler: { kind: "expression", args: ["integer"], returns: "boolean" },
    create_int_array_consumer: { kind: "expression", args: ["integer", "integer"] },
};

const VALUE_TYPES = {
    asVec2: "vec2",
    asVec3: "vec3",
    asVec4: "vec4",
    asColor: "color",
    asBool: "bool",
    asInt: "int",
    asFloat: "number",
    getText: "string",
};

/** String attributes that name something; checked against the extraction. */
const SEMANTIC = {
    "*.id": "id",
    "*.font": "font",
    "image.src": "texture",
    "image.fallback": "texture",
    "modelviewer.src": "model",
    "iframe.src": "layout",
    "bindbox.binding": "binding",
    "*.context": "locale-context",
    // '', 'false' and 'nil' are false, anything else is true (UiXmlReader::readUINode)
    "*.if": "condition",
    "*.ifnot": "condition",
};

/** Sub-elements read by their parent's reader rather than registered with add(). */
const SUB_ELEMENTS = {
    option: { parent: "select", receiver: "elem" },
    slot: { parent: "inventory", reader: "read_slot" },
    "slots-grid": { parent: "inventory", reader: "read_slots_grid" },
};

/** String attributes compared outside gui_xml.cpp → engineEnums() list. */
const ENUM_ATTRS = {
    markup: "markup", // Label / TextBox `markup == "md"`
    syntax: "syntax", // SyntaxProcessor: an extension from res/devtools/syntax
};

/** Values the engine accepts but only compares one of (the other is the default). */
const EXTRA_VALUES = {
    orientation: ["vertical"],
    mode: ["select"],
};

function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Splits `a, f(b, c), d` at top-level commas. */
function splitArgs(text) {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of text) {
        if ("([{<".includes(ch)) depth++;
        else if (")]}>".includes(ch)) depth--;
        if (ch === "," && depth === 0) {
            out.push(cur.trim());
            cur = "";
        } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function matchClose(text, open) {
    const pairs = { "(": ")", "{": "}" };
    const close = pairs[text[open]];
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === text[open]) depth++;
        else if (text[i] === close && --depth === 0) return i;
    }
    throw new Error(`unbalanced ${text[open]} at ${open}`);
}

/** Top-level function definitions: name, params, normalized body. */
function parseFunctions(src) {
    const fns = [];
    const header = /^(?:static\s+)?[\w:<>]+(?:\s*[&*])?\s+(\w+(?:::\w+)?)\s*\(/gm;
    for (let m; (m = header.exec(src)); ) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(src, open);
        const after = src.slice(close + 1).match(/^\s*(?:const\s*)?\{/);
        if (!after) continue;
        const bodyOpen = close + 1 + after[0].length - 1;
        const bodyClose = matchClose(src, bodyOpen);
        const params = splitArgs(src.slice(open + 1, close)).map((p) => {
            const pm = p.match(/^(.*?)\s*\b(\w+)\s*(?:=\s*(.+))?$/);
            return { type: pm[1], name: pm[2], default: pm[3]?.trim() };
        });
        const body = src.slice(bodyOpen + 1, bodyClose).replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
        fns.push({ name: m[1], params, body });
        header.lastIndex = bodyClose;
    }
    return fns;
}

/** class X : public Y in the element headers → X's bases. */
function classBases() {
    const bases = new Map();
    const dir = path.join(ROOT, "src/graphics/ui/elements");
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".hpp"))) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        for (const m of text.matchAll(/class\s+(\w+)(?:\s+final)?\s*:\s*((?:public\s+[\w:]+\s*,?\s*)+)\{/g)) {
            bases.set(m[1], [...m[2].matchAll(/public\s+(?:\w+::)*(\w+)/g)].map((b) => b[1]));
        }
        for (const m of text.matchAll(/std::shared_ptr<(\w+)>\s+(\w+)\(/g)) bases.set(`returns:${m[2]}`, [m[1]]);
    }
    return bases;
}

function derivesFrom(bases, cls, target) {
    if (cls === target) return true;
    return (bases.get(cls) ?? []).some((b) => derivesFrom(bases, b, target));
}

function engineEnums(src) {
    const align = [...src.match(/static Align align_from_string[\s\S]*?\n\}/)[0].matchAll(/str == "([\w-]+)"/g)].map((m) => m[1]);
    const gravity = [...src.match(/gravity_names \{[\s\S]*?\};/)[0].matchAll(/\{"([\w-]+)"/g)].map((m) => m[1]);
    const commons = read("src/graphics/core/commons.hpp");
    const cursor = [...commons.match(/VC_ENUM_METADATA\(CursorShape\)[\s\S]*?VC_ENUM_END/)[0].matchAll(/\{"([\w-]+)"/g)].map((m) => m[1]);
    const markup = [...new Set(["Label.cpp", "TextBox.cpp"].flatMap((f) =>
        [...read(`src/graphics/ui/elements/${f}`).matchAll(/markup == "(\w+)"/g)].map((m) => m[1])))];
    // TextBox syntax = a file extension of res/devtools/syntax/*.toml (SyntaxProcessor)
    const syntaxDir = path.join(ROOT, "res/devtools/syntax");
    const syntax = fs.readdirSync(syntaxDir).filter((f) => f.endsWith(".toml")).flatMap((f) => {
        const m = fs.readFileSync(path.join(syntaxDir, f), "utf8").match(/^extensions\s*=\s*\[([^\]]*)\]/m);
        return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    }).sort();
    for (const [name, list] of Object.entries({ align, gravity, cursor, markup, syntax })) {
        if (!list.length) fail(`could not extract the ${name} values`);
    }
    return { align, gravity, cursor, markup, syntax };
}

// ------------------------------------------------------------ attribute extraction

const ATTR_RE = /\b(element|elem)(\.|->)(attr|has)\((?:"([^"]*)"|(\w+))(?:, "([^"]*)")?\)(?:\.(\w+)\(\))?/g;

class Analyzer {
    constructor(src) {
        this.src = src;
        this.fns = parseFunctions(src);
        this.byName = new Map();
        for (const fn of this.fns) {
            if (fn.name === "UiXmlReader::readUINode") {
                // overloads: (element) / (reader, element, Container&) / (reader, element, UINode&)
                const key = fn.params.length === 1 ? "readUINode" : fn.params[2].type.includes("Container") ? "readUINode<Container>" : "readUINode<UINode>";
                this.byName.set(key, fn);
            } else this.byName.set(fn.name, fn);
        }
        this.bases = classBases();
        this.enums = engineEnums(src);
        this.memo = new Map();
    }

    /** Attributes a function reads on `receiver`, and how its parameters are used as attribute names. */
    analyze(name, receiver = "element") {
        const key = `${name}/${receiver}`;
        if (this.memo.has(key)) return this.memo.get(key);
        const fn = this.byName.get(name);
        if (!fn) throw new Error(`function ${name} not found in ${SOURCE}`);
        const result = { attrs: new Map(), paramAttrs: new Map(), elements: false, text: false };
        this.memo.set(key, result);
        const statements = fn.body.split(/[;{}]/).map((s) => s.trim()).filter(Boolean);
        const vars = new Map(); // local variable → attribute key it holds

        const record = (target, attrName, info, group) => {
            const cur = target.get(attrName) ?? { group };
            for (const [k, v] of Object.entries(info)) {
                if (v === undefined) continue;
                if (k === "values") cur.values = [...new Set([...(cur.values ?? []), ...v])];
                else if (k === "type" && cur.type && cur.type !== v) {
                    // `has` checks and getText for asX reads add nothing
                    if (cur.type === "string") cur.type = v;
                    else if (v !== "string") fail(`${name}: attribute ${attrName} read as ${cur.type} and ${v}`);
                } else if (cur[k] === undefined) cur[k] = v;
            }
            target.set(attrName, cur);
        };
        const paramIndex = (p) => fn.params.findIndex((x) => x.name === p);

        for (const st of statements) {
            for (const m of st.matchAll(ATTR_RE)) {
                const [, recv, , method, literal, param, def, valueMethod] = m;
                if (recv !== receiver) continue;
                const info = {};
                if (method === "attr") {
                    info.type = valueMethod ? VALUE_TYPES[valueMethod] : undefined;
                    if (valueMethod && !info.type) fail(`${name}: unknown value method ${valueMethod}`);
                    if (def !== undefined) info.default = def;
                }
                const factory = st.match(/scripting::(create_\w+)\(/)?.[1];
                if (factory) info.lua = this.luaKind(name, factory);
                if (st.includes("align_from_string(")) info.values = this.enums.align;
                if (st.includes("gravity_from_string(")) info.values = this.enums.gravity;
                if (st.includes("CursorShapeMeta")) info.values = this.enums.cursor;
                const cmp = [...st.matchAll(/getText\(\) == "([\w-]+)"/g)].map((x) => x[1]);
                if (cmp.length) info.values = cmp;
                const assigned = st.match(/^(?:[\w:&<>]+\s+)*?(?:auto&?|const std::string&|std::string|float|int|bool|glm::vec[234])\s+(\w+) =/)?.[1];
                const attrKey = literal ?? `$${param}`;
                if (assigned) vars.set(assigned, attrKey);
                if (literal !== undefined) record(result.attrs, literal, info, name);
                else if (paramIndex(param) >= 0) record(result.paramAttrs, paramIndex(param), info, name);
            }
            // flows through a local: `auto x = ...attr("a")...; if (x[0] == '@')`, `x == "horizontal"`, `create_*(..., x, ...)`
            for (const [v, attrKey] of vars) {
                const info = {};
                if (new RegExp(`\\b${v}\\[0\\] == '@'`).test(st)) info.localizable = true;
                const cmp = [...st.matchAll(new RegExp(`\\b${v} == "([\\w-]+)"`, "g"))].map((x) => x[1]);
                if (cmp.length) info.values = cmp;
                const factory = st.match(new RegExp(`scripting::(create_\\w+)\\([^;]*\\b${v}\\b`))?.[1];
                if (factory) info.lua = this.luaKind(name, factory);
                if (!Object.keys(info).length) continue;
                if (attrKey.startsWith("$")) {
                    const idx = paramIndex(attrKey.slice(1));
                    if (idx >= 0) record(result.paramAttrs, idx, info, name);
                } else record(result.attrs, attrKey, info, name);
            }
            if (receiver !== "element") continue;
            if (/reader\.readUINode\(\*/.test(st)) result.elements = true;
            if (/parse_inner_text\(element\b/.test(st)) result.text = true;
            this.followCalls(name, fn, st, result, record);
        }
        return result;
    }

    luaKind(where, factory) {
        const kind = LUA_FACTORIES[factory];
        if (!kind) fail(`${where}: unknown Lua factory scripting::${factory} (add it to LUA_FACTORIES)`);
        return kind;
    }

    followCalls(name, fn, st, result, record) {
        for (const [callee, cfn] of this.byName) {
            if (callee === name || callee.startsWith("readUINode")) continue;
            const re = new RegExp(`(?<![\\w.>])${callee}\\(`, "g");
            for (const m of st.matchAll(re)) {
                const open = m.index + m[0].length - 1;
                const args = splitArgs(st.slice(open + 1, matchClose(st, open)));
                this.inherit(name, fn, cfn, callee, args, result, record);
            }
        }
        // reader.readUINode(reader, element, *x): the overload depends on x's class
        for (const m of st.matchAll(/reader\.readUINode\(reader, element, \*(\w+)\)/g)) {
            const cls = this.classOf(fn, m[1]);
            const overload = derivesFrom(this.bases, cls, "Container") ? "readUINode<Container>" : "readUINode<UINode>";
            this.inherit(name, fn, this.byName.get(overload), overload, ["reader", "element", m[1]], result, record);
        }
    }

    inherit(caller, callerFn, cfn, callee, args, result, record) {
        const elementParam = cfn.params.findIndex((p) => p.name === "element");
        if (elementParam < 0) return;
        const sub = this.analyze(callee);
        if (args[elementParam] === "element") {
            for (const [attr, info] of sub.attrs) record(result.attrs, attr, info, info.group);
            if (sub.text) result.text = true;
            const flag = cfn.params.findIndex((p) => p.name === "subnodes");
            if (flag >= 0) {
                const value = args[flag] ?? cfn.params[flag].default;
                if (value === "true") result.elements = true;
                else if (value !== "false") fail(`${callee}: can't tell the subnodes argument (${value})`);
            } else if (sub.elements) result.elements = true;
        }
        for (const [idx, info] of sub.paramAttrs) {
            const arg = args[idx];
            const literal = arg?.match(/^"([^"]+)"$/)?.[1];
            if (literal) record(result.attrs, literal, { ...info, group: caller }, caller); // the caller names it
            else if (arg && args[elementParam] === "element") {
                // forwarded parameter: register_action → create_runnable(reader, element, name)
                const own = callerFn.params.findIndex((p) => p.name === arg);
                if (own >= 0) record(result.paramAttrs, own, info, info.group);
            }
        }
    }

    classOf(fn, variable) {
        const made = fn.body.match(new RegExp(`\\b${variable} = std::make_shared<(\\w+)>`))?.[1];
        if (made) return made;
        const call = fn.body.match(new RegExp(`\\b${variable} = \\w+(?:->|\\.)(\\w+)\\(`))?.[1];
        const returned = call && this.bases.get(`returns:${call}`)?.[0];
        if (!returned) fail(`${fn.name}: can't tell the class of ${variable} for readUINode`);
        return returned ?? "UINode";
    }
}

// ------------------------------------------------------------ docs

const DOC_GROUPS = {
    "Common element attributes": "group:node",
    "Template attributes": "group:template",
    "Common *container* attributes": "group:container",
    "Common *panel* attributes": "group:panel",
};

/** Engine function → doc group of the attributes it reads. */
const FUNCTION_GROUPS = {
    read_uinode: "node",
    "readUINode": "template",
    read_container_impl: "container",
    read_base_panel_impl: "panel",
    read_panel_impl: "panel",
};

function parseDoc() {
    const text = read(DOC);
    const sections = new Map(); // key: group name or element tag
    const types = {};
    let current = null;
    let lastAttr = null;
    let lastType = null;
    let inCode = false;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith("```")) inCode = !inCode;
        if (inCode) continue;
        const h = line.match(/^(#{1,2}) (.+)$/);
        if (h) {
            const title = h[2].trim();
            const tag = title.match(/\*([\w-]+)\*/)?.[1];
            const key = DOC_GROUPS[title] ?? (h[1] === "##" && tag ? tag : null);
            current = key ? { key, description: [], attrs: new Map() } : null;
            if (current) sections.set(key, current);
            lastAttr = null;
            lastType = null;
            continue;
        }
        const typeDef = line.match(/^\*\*(.+?)\*\* - (.+)$/);
        if (typeDef) {
            lastType = typeDef[1];
            types[lastType] = { description: typeDef[2], examples: [] };
            continue;
        }
        if (lastType && !current) {
            const ex = line.match(/^- `"([^"]*)"`/);
            if (ex) types[lastType].examples.push(ex[1]);
            continue;
        }
        if (!current) continue;
        const valueDoc = line.match(/^\s{2,}- `([\w-]+)` - (.+)$/);
        if (valueDoc && lastAttr) {
            (lastAttr.values ??= {})[valueDoc[1]] = valueDoc[2].trim();
            continue;
        }
        // `- \`name\` - text`, and the template attributes' `- \`if\` with values ...`
        const bullet = line.match(/^- `([\w-]+)`\s*(?:- )?(.*)$/);
        if (bullet) {
            lastAttr = { description: bullet[2].trim() };
            current.attrs.set(bullet[1], lastAttr);
            continue;
        }
        if (/^\s*$/.test(line)) {
            lastAttr = null;
            continue;
        }
        if (lastAttr && !/^\s*[-#>]/.test(line)) {
            lastAttr.description += " " + line.trim();
        } else if (!lastAttr && current.attrs.size === 0 && !/^\s*[-#>]/.test(line)) {
            current.description.push(line.trim());
        }
    }
    return { sections, types };
}

function docDefault(description) {
    return description?.match(/Default:\s*"?([^\s".]+(?:\.\d+)?)"?/)?.[1];
}

const sameDefault = (a, b) => a === b || (Number.isFinite(Number(a)) && Number(a) === Number(b));

// ------------------------------------------------------------ build

function build() {
    const src = stripComments(read(SOURCE));
    const analyzer = new Analyzer(src);
    const enums = analyzer.enums;
    const { sections, types } = parseDoc();
    const registered = [...src.matchAll(/\badd\("([\w-]+)", (\w+)\)/g)].map((m) => ({ tag: m[1], reader: m[2] }));
    if (!registered.length) fail(`no add("tag", reader) registrations found in ${SOURCE}`);
    const template = analyzer.analyze("readUINode");
    const usedDoc = new Set();
    const undocumented = new Map(); // attribute → elements

    const describe = (tag, attr, group) => {
        const groupKey = FUNCTION_GROUPS[group] && `group:${FUNCTION_GROUPS[group]}`;
        for (const key of [tag, groupKey, ...Object.values(DOC_GROUPS)]) {
            const doc = key && sections.get(key)?.attrs.get(attr);
            if (doc) {
                usedDoc.add(`${key}.${attr}`);
                return doc;
            }
        }
        return undefined;
    };

    const finish = (tag, attrs) => {
        const out = {};
        for (const [attr, info] of attrs) {
            const entry = {};
            let type = info.lua ? "lua" : info.type ?? (info.values ? "string" : undefined);
            if (!type) {
                fail(`${tag}: no type for attribute ${attr} (only checked with has())`);
                continue;
            }
            const semantic = SEMANTIC[`${tag}.${attr}`] ?? SEMANTIC[`*.${attr}`];
            if (semantic && type === "string") type = semantic;
            const engineValues = ENUM_ATTRS[attr] && enums[ENUM_ATTRS[attr]];
            if (engineValues) info.values = [...(info.values ?? []), ...engineValues];
            const values = !semantic && info.values && [...new Set([...info.values, ...(EXTRA_VALUES[attr] ?? []), ...(info.default ? [info.default] : [])])];
            if (values && type === "string") type = "enum";
            entry.type = type;
            if (values && type === "enum") entry.values = values.filter((v) => v !== "");
            if (info.default !== undefined && info.default !== "") entry.default = info.default;
            if (info.lua) entry.lua = info.lua;
            if (info.localizable) entry.localizable = true;
            entry.group = FUNCTION_GROUPS[info.group] ?? "element";
            const doc = describe(tag, attr, info.group);
            if (doc) {
                entry.description = doc.description;
                if (doc.values) entry.valueDescriptions = doc.values;
                const dd = docDefault(doc.description);
                if (dd && entry.default !== undefined && !sameDefault(dd, entry.default)) {
                    warn(`${tag}.${attr}: doc default ${dd}, engine default ${entry.default}`);
                }
            } else undocumented.set(attr, [...(undocumented.get(attr) ?? []), tag]);
            out[attr] = entry;
        }
        return out;
    };

    const elements = {};
    for (const { tag, reader } of registered) {
        const r = analyzer.analyze(reader);
        const attrs = new Map([...template.attrs, ...r.attrs]);
        const section = sections.get(tag);
        if (!section) warn(`element ${tag} is not documented`);
        const children = Object.entries(SUB_ELEMENTS).filter(([, s]) => s.parent === tag).map(([name]) => name);
        elements[tag] = {
            ...(section?.description.length ? { description: section.description.join(" ") } : {}),
            reader,
            content: { text: r.text, elements: r.elements, ...(children.length ? { children } : {}) },
            attributes: finish(tag, attrs),
        };
    }
    for (const [tag, sub] of Object.entries(SUB_ELEMENTS)) {
        const parentReader = registered.find((r) => r.tag === sub.parent)?.reader;
        const parentBody = parentReader && analyzer.byName.get(parentReader)?.body;
        if (!parentBody?.includes(`"${tag}"`)) {
            fail(`sub-element ${tag} is no longer read by ${sub.parent}`);
            continue;
        }
        const r = sub.reader ? analyzer.analyze(sub.reader) : analyzer.analyze(parentReader, sub.receiver);
        const text = sub.receiver ? new RegExp(`parse_inner_text\\(\\*${sub.receiver}\\b`).test(parentBody) : r.text;
        const section = sections.get(tag);
        elements[tag] = {
            ...(section?.description.length ? { description: section.description.join(" ") } : {}),
            reader: sub.reader ?? parentReader,
            parent: sub.parent,
            content: { text, elements: r.elements },
            attributes: finish(tag, r.attrs),
        };
    }
    for (const sem of Object.keys(SEMANTIC)) {
        const [tag, attr] = sem.split(".");
        const found = tag === "*" ? Object.values(elements).some((e) => e.attributes[attr]) : elements[tag]?.attributes[attr];
        if (!found) fail(`SEMANTIC entry ${sem}: the engine doesn't read it`);
    }
    for (const [attr, tags] of undocumented) {
        warn(`attribute ${attr} is not documented (${tags.length === Object.keys(elements).length ? "all elements" : tags.join(", ")})`);
    }
    for (const [key, section] of sections) {
        for (const attr of section.attrs.keys()) {
            if (!usedDoc.has(`${key}.${attr}`)) warn(`documented ${key}.${attr} is not read by the engine`);
        }
    }
    return {
        $comment: `Generated by tools/gen-layouts.mjs from ${SOURCE} and ${DOC}. Do not edit.`,
        types: {
            vec2: types["2D vector"],
            vec3: types["3D vector"],
            vec4: types["4D vector"],
            color: types["RGBA color"],
        },
        enums: analyzer.enums,
        elements,
    };
}

/**
 * TextMate injection: Lua inside the attributes the engine runs as Lua. A
 * grammar can't be limited to layouts/ by path, so it matches only these
 * exact attribute names, inside any XML tag.
 */
function luaInjection(data) {
    const names = new Set();
    for (const element of Object.values(data.elements)) {
        for (const [name, attr] of Object.entries(element.attributes)) if (attr.lua) names.add(name);
    }
    const alternation = [...names].sort().map((n) => n.replace(/[-.]/g, (c) => `\\${c}`)).join("|");
    const value = (quote, kind) => ({
        // starts where xml.tmLanguage's attribute rule starts (at the spaces), so
        // the L: injection wins the tie; the earliest match would win otherwise
        begin: `(?:^|\\s+)(${alternation})(\\s*)(=)(\\s*)(${quote})`,
        beginCaptures: {
            1: { name: "entity.other.attribute-name.localname.xml" },
            3: { name: "punctuation.separator.key-value.xml" },
            5: { name: `string.quoted.${kind}.xml punctuation.definition.string.begin.xml` },
        },
        end: quote,
        endCaptures: { 0: { name: `string.quoted.${kind}.xml punctuation.definition.string.end.xml` } },
        contentName: "meta.embedded.inline.lua",
        patterns: [{ include: "source.lua" }],
    });
    return {
        $comment: `Generated by tools/gen-layouts.mjs from ${SOURCE}. Do not edit.`,
        scopeName: "voxelcore.layout.lua-attributes",
        injectionSelector: "L:meta.tag.xml -comment",
        patterns: [value('"', "double"), value("'", "single")],
    };
}

function main() {
    if (!fs.existsSync(path.join(ROOT, SOURCE))) {
        console.error(`gen-layouts: engine sources not found at ${ROOT} (set VOXELCORE_ROOT)`);
        process.exit(2);
    }
    let data;
    try {
        data = build();
    } catch (e) {
        fail(e.stack ?? String(e));
    }
    if (!CHECK_ONLY || process.argv.includes("--verbose")) for (const w of warnings) console.warn(`warning: ${w}`);
    if (errors.length) {
        for (const e of errors) console.error(`error: ${e}`);
        console.error(`gen-layouts: ${errors.length} error(s); nothing written.`);
        process.exit(1);
    }
    for (const [file, value] of [[OUT, data], [GRAMMAR, luaInjection(data)]]) {
        const text = JSON.stringify(value, null, 2) + "\n";
        const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        if (old === text) continue;
        if (CHECK_ONLY) {
            console.error(`gen-layouts --check: ${path.relative(EXT, file)} is stale. Run: node tools/gen-layouts.mjs`);
            process.exit(1);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    console.log(`gen-layouts: ${Object.keys(data.elements).length} elements ${CHECK_ONLY ? "up to date" : "written"} (${warnings.length} warning(s))`);
}

main();
