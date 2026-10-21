import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import * as t from "../../src/scaffold/templates";
import { parsePackManifest } from "../../src/packs.manifest";

test("pack id validation follows ContentPack rules", () => {
    assert.equal(t.validatePackId("my_pack"), undefined);
    assert.equal(t.validatePackId("Ab"), undefined);
    assert.ok(t.validatePackId("a"), "too short");
    assert.ok(t.validatePackId("1pack"), "starts with a digit");
    assert.ok(t.validatePackId("a".repeat(25)), "too long");
    assert.ok(t.validatePackId("my-pack"), "dash not allowed");
    assert.ok(t.validatePackId("core"), "reserved");
    assert.ok(t.validatePackId("packid"), "reserved");
});

test("captions match util::id_to_caption", () => {
    assert.equal(t.idToCaption("ceiling_tile"), "ceiling tile");
    assert.equal(t.idToCaption("_hidden_x"), "hidden x");
});

test("locale entries are appended once", () => {
    let text = t.addLocaleEntry("", "red lamp", "red lamp");
    text = t.addLocaleEntry(text, "red lamp", "other");
    assert.equal(text, "red lamp=red lamp\n");
    assert.equal(t.addLocaleEntry("a=b", "c", "d"), "a=b\nc=d\n");
});

test("block templates are valid JSON with the requested shape", () => {
    const faces = JSON.parse(t.blockJson("door", "faces", true));
    assert.equal(faces["texture-faces"].length, 6);
    assert.equal(faces.material, "base:stone");
    const model = JSON.parse(t.blockJson("lamp", "model", false));
    assert.equal(model.model, "custom");
    assert.equal(model["model-name"], "lamp");
    assert.equal(model.material, undefined, "no base dependency → no base material");
    assert.deepEqual(t.blockTextureNames("door", "faces"), ["door_side", "door_bottom", "door_top"]);
});

test("placeholder textures are decodable PNGs", () => {
    const png = PNG.sync.read(t.placeholderPng("stone"));
    assert.equal(png.width, 16);
    assert.equal(png.data[3], 255);
});

test("pack manifests are told apart from npm manifests", () => {
    assert.deepEqual(parsePackManifest('{"id":"base","title":"Base"}'), { id: "base", title: "Base", dependencies: [] });
    assert.equal(parsePackManifest('{"name":"x","dependencies":{"a":"1"}}'), undefined);
    assert.equal(parsePackManifest('{"id":"x","dependencies":{"a":"1"}}'), undefined);
    assert.equal(parsePackManifest("not json"), undefined);
});
