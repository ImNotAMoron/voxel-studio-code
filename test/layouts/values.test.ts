import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { layoutAttribute } from "../../shared/layouts";
import { checkLayoutValue, readDouble, readInt } from "../../shared/layouts/values";

const check = (tag: string, name: string, value: string) => checkLayoutValue(name, layoutAttribute(tag, name)!, value);
const kind = (tag: string, name: string, value: string) => check(tag, name, value)?.kind ?? "ok";

describe("number models", () => {
    test("util::parse_double = from_chars on a prefix", () => {
        assert.equal(readDouble("1.5").value, 1.5);
        assert.equal(readDouble("  +2").value, 2);
        assert.equal(readDouble("-.5e1").value, -5);
        assert.equal(readDouble("5abc").value, 5);
        assert.equal(readDouble("5abc").rest, "abc");
        assert.equal(readDouble("1e").rest, "e");
        assert.equal(readDouble("inf").value, Infinity);
        assert.equal(readDouble("abc").value, undefined);
        assert.equal(readDouble("").value, undefined);
        assert.equal(readDouble("0x10").value, 0);
    });
    test("std::stoll + int cast", () => {
        assert.equal(readInt(" 42").value, 42);
        assert.equal(readInt("1.5").value, 1);
        assert.equal(readInt("-3px").rest, "px");
        assert.equal(readInt("x").value, undefined);
        assert.equal(readInt("99999999999999999999").outOfRange, true);
        assert.equal(readInt("4294967297").value, 1, "truncated to int");
    });
});

describe("attribute values", () => {
    test("vectors: one number for all, exact component counts, commas only", () => {
        assert.equal(kind("panel", "size", "100,50"), "ok");
        assert.equal(kind("panel", "size", "100"), "ok");
        assert.equal(kind("panel", "size", " 100 , 50 "), "ok");
        assert.equal(kind("panel", "size", "100 50"), "misread");
        assert.equal(kind("panel", "size", "1,2,3"), "misread");
        assert.equal(kind("panel", "margin", "4"), "ok");
        assert.equal(kind("panel", "margin", "1,2"), "throws");
        assert.equal(kind("panel", "margin", "1,2,3"), "throws");
        assert.equal(kind("panel", "margin", "1,2,3,4"), "ok");
        assert.equal(kind("modelviewer", "center", "0.5,0.5"), "throws");
        assert.equal(kind("panel", "pos", ""), "throws");
        assert.equal(kind("panel", "pos", "a,1"), "throws");
        assert.match(check("panel", "margin", "1,,3,4")!.message, /component 2 is empty/);
        // the span points at the ignored part
        assert.deepEqual([check("panel", "padding", "1,2,3,4,5")!.start, check("panel", "padding", "1,2,3,4,5")!.end], [7, 9]);
    });
    test("colours: hex with 6 or 8 digits, or r,g,b,a", () => {
        assert.equal(kind("panel", "color", "#FF8000"), "ok");
        assert.equal(kind("panel", "color", "#FFFFFF80"), "ok");
        assert.equal(kind("panel", "color", "#fff"), "throws");
        assert.equal(kind("panel", "color", "#GG0000"), "misread");
        assert.equal(kind("panel", "color", "255,128,0,255"), "ok");
        assert.equal(kind("panel", "color", "0"), "ok");
        assert.equal(kind("panel", "color", "255,0,0"), "throws");
        assert.equal(kind("panel", "color", ""), "throws");
    });
    test("booleans: only 'true' and '1' are true", () => {
        for (const v of ["true", "false", "1", "0"]) assert.equal(kind("panel", "visible", v), "ok");
        assert.equal(check("panel", "visible", "True")!.suggestion, "true");
        assert.equal(kind("panel", "visible", "no"), "misread");
        assert.match(check("panel", "visible", "")!.message, /without a value/);
    });
    test("integers and numbers", () => {
        assert.equal(kind("panel", "z-index", "3"), "ok");
        assert.equal(kind("panel", "z-index", "-1"), "ok");
        assert.equal(kind("panel", "z-index", "1.5"), "misread");
        assert.equal(kind("panel", "z-index", "top"), "throws");
        assert.equal(kind("panel", "interval", "2.5"), "ok");
        assert.equal(kind("panel", "interval", "2px"), "misread");
        assert.equal(kind("panel", "interval", "wide"), "throws");
    });
    test("enums: exact (case-sensitive) values, with suggestions and the engine's fallback", () => {
        assert.equal(kind("panel", "orientation", "horizontal"), "ok");
        assert.equal(check("panel", "orientation", "Horizontal")!.suggestion, "horizontal");
        assert.match(check("panel", "orientation", "row")!.message, /anything but 'horizontal' is vertical/);
        assert.equal(check("label", "gravity", "top-centre")!.suggestion, "top-center");
        assert.equal(kind("label", "cursor", "pointer"), "ok");
        assert.equal(kind("textbox", "syntax", "lua"), "ok");
        assert.equal(kind("label", "markup", "md"), "ok");
    });
    test("not checked: strings, Lua, conditions, template placeholders", () => {
        assert.equal(kind("label", "id", "anything goes"), "ok");
        assert.equal(kind("label", "onclick", "a b c"), "ok");
        assert.equal(kind("label", "if", "maybe"), "ok");
        assert.equal(kind("panel", "size", "%{w},40"), "ok");
        assert.equal(kind("panel", "z-index", "%{index}"), "ok");
    });
});
