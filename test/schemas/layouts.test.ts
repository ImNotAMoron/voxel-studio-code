import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { childTags, layoutAttribute, layoutElement, layoutElements, layoutEnums, uiNodeTags } from "../../shared/layouts";

const EXT = path.join(__dirname, "..", "..");
const ROOT = path.join(EXT, "..");
const engineAvailable = fs.existsSync(path.join(ROOT, "src", "graphics", "ui", "gui_xml.cpp"));

describe("layout elements (gen-layouts)", () => {
    test("output is up to date with gui_xml.cpp (gen-layouts --check)", { skip: !engineAvailable }, () => {
        execFileSync(process.execPath, [path.join(EXT, "tools", "gen-layouts.mjs"), "--check"], {
            env: { ...process.env, VOXELCORE_ROOT: ROOT },
            stdio: "pipe",
        });
    });

    test("every element registered with add() is there, sub-elements have parents", () => {
        const tags = uiNodeTags();
        for (const tag of ["image", "canvas", "iframe", "label", "panel", "button", "select", "textbox", "pagebox",
            "splitbox", "checkbox", "trackbar", "container", "bindbox", "modelviewer", "inventory"]) {
            assert.ok(tags.includes(tag), tag);
        }
        assert.equal(layoutElement("option")?.parent, "select");
        assert.equal(layoutElement("slot")?.parent, "inventory");
        assert.deepEqual(layoutElement("inventory")?.content.children, ["slot", "slots-grid"]);
        assert.ok(!tags.includes("slot"));
        assert.equal(layoutElement("toString"), undefined);
    });

    test("attributes follow the reader's helper calls", () => {
        // read_uinode via read_container_impl / read_panel_impl
        assert.equal(layoutAttribute("panel", "pos")?.type, "vec2");
        assert.equal(layoutAttribute("panel", "pos")?.group, "node");
        assert.equal(layoutAttribute("button", "scrollable")?.group, "container");
        assert.equal(layoutAttribute("checkbox", "max-length")?.group, "panel");
        // only read_panel reads `interval` (the docs list it for every panel)
        assert.equal(layoutAttribute("panel", "interval")?.default, "2");
        assert.equal(layoutAttribute("button", "interval"), undefined);
        // template attributes are read for registered elements only
        assert.equal(layoutAttribute("label", "if")?.type, "condition");
        assert.equal(layoutAttribute("slot", "if"), undefined);
        // InventoryView is a Container, SlotView is not
        assert.equal(layoutAttribute("inventory", "scrollable")?.group, "container");
        assert.equal(layoutAttribute("slot", "scrollable"), undefined);
        assert.equal(layoutAttribute("slot", "tooltip")?.group, "node");
    });

    test("value types, defaults and enums come from the engine", () => {
        assert.equal(layoutAttribute("label", "color")?.type, "color");
        assert.equal(layoutAttribute("panel", "padding")?.type, "vec4");
        assert.equal(layoutAttribute("slots-grid", "padding")?.type, "int");
        assert.equal(layoutAttribute("modelviewer", "center")?.type, "vec3");
        assert.equal(layoutAttribute("trackbar", "track-width")?.default, "12");
        assert.deepEqual(layoutAttribute("panel", "orientation")?.values, ["horizontal", "vertical"]);
        assert.equal(layoutAttribute("splitbox", "orientation")?.default, "vertical");
        assert.deepEqual(layoutAttribute("select", "mode")?.values, ["button", "select"]);
        assert.ok(layoutAttribute("label", "gravity")?.values?.includes("bottom-right"));
        assert.ok(layoutAttribute("label", "cursor")?.values?.includes("pointer"));
        assert.deepEqual(layoutAttribute("label", "markup")?.values, ["md"]);
        assert.ok(layoutAttribute("textbox", "syntax")?.values?.includes("lua"));
        assert.deepEqual(layoutEnums.align, ["left", "center", "right", "top", "bottom"]);
    });

    test("named strings and localizable text", () => {
        assert.equal(layoutAttribute("image", "src")?.type, "texture");
        assert.equal(layoutAttribute("modelviewer", "src")?.type, "model");
        assert.equal(layoutAttribute("iframe", "src")?.type, "layout");
        assert.equal(layoutAttribute("bindbox", "binding")?.type, "binding");
        assert.equal(layoutAttribute("label", "font")?.type, "font");
        assert.equal(layoutAttribute("label", "tooltip")?.localizable, true);
        assert.equal(layoutAttribute("textbox", "hint")?.localizable, true);
        assert.equal(layoutAttribute("textbox", "placeholder")?.localizable, undefined);
        assert.equal(layoutElement("label")?.content.text, true);
        assert.equal(layoutElement("option")?.content.text, true);
        assert.equal(layoutElement("image")?.content.text, false);
    });

    test("Lua callbacks: chunks and expressions with their signatures", () => {
        assert.deepEqual(layoutAttribute("panel", "onclick")?.lua, { kind: "chunk" });
        assert.equal(layoutAttribute("panel", "onclick")?.group, "node");
        assert.deepEqual(layoutAttribute("panel", "position-func")?.lua, { kind: "expression", returns: "vec2" });
        assert.deepEqual(layoutAttribute("checkbox", "consumer")?.lua, { kind: "expression", args: ["boolean"] });
        assert.deepEqual(layoutAttribute("trackbar", "supplier")?.lua, { kind: "expression", returns: "number" });
        assert.deepEqual(layoutAttribute("textbox", "validator")?.lua, { kind: "expression", args: ["string"], returns: "boolean" });
        assert.deepEqual(layoutAttribute("textbox", "onup")?.lua, { kind: "chunk" });
        assert.deepEqual(layoutAttribute("select", "onselect")?.lua, { kind: "expression", args: ["string"] });
        assert.deepEqual(layoutAttribute("slot", "updatefunc")?.lua, { kind: "expression", args: ["integer", "integer"] });
    });

    test("children: which elements read sub-elements or text", () => {
        assert.deepEqual(childTags("image"), []);
        assert.ok(childTags("panel").includes("button"));
        assert.ok(!childTags("panel").includes("option"));
        assert.deepEqual(childTags("select"), ["option"]);
        assert.deepEqual(childTags("inventory").slice(0, 2), ["slot", "slots-grid"]);
        assert.ok(childTags("inventory").includes("label"));
        assert.equal(layoutElement("button")?.content.text, true);
        assert.equal(layoutElement("button")?.content.elements, true);
    });

    test("descriptions are merged from the docs", () => {
        assert.match(layoutElement("panel")?.description ?? "", /orientation/);
        assert.match(layoutAttribute("panel", "id")?.description ?? "", /identifier/);
        assert.match(layoutAttribute("button", "padding")?.description ?? "", /padding/);
        assert.equal(layoutAttribute("select", "mode")?.valueDescriptions?.button !== undefined, true);
        for (const [tag, element] of Object.entries(layoutElements)) {
            for (const [name, attr] of Object.entries(element.attributes)) {
                assert.ok(attr.type, `${tag}.${name}`);
                if (attr.type === "enum") assert.ok(attr.values?.length, `${tag}.${name} values`);
                if (attr.type === "lua") assert.ok(attr.lua, `${tag}.${name} lua`);
            }
        }
    });
});
