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

test("layout templates lint clean, with every callback defined in the script", async () => {
    const { ContentIndex } = await import("../../shared/content/index");
    const { createEnv, lintDocument } = await import("../../server/src/linter");
    const { GOODPACK, RES } = await import("../server/helpers");
    const path = await import("node:path");
    const env = createEnv(new ContentIndex({ resPath: RES, packDirs: [GOODPACK] }), {}, false);
    for (const kind of ["screen", "inventory", "empty"] as t.LayoutKind[]) {
        // linted where no .xml.lua exists: names may only be undefined if the template's script defines them
        const defined = new Set([...t.layoutScript(kind).matchAll(/^function (\w+)/gm)].map((m) => m[1]));
        const noisy = lintDocument(env, path.join(GOODPACK, "layouts", "test.xml"), t.layoutXml(kind))
            .filter((d) => !(d.code === "VC0411" && defined.has(/'(\w+)'/.exec(d.message)?.[1] ?? "")));
        assert.deepEqual(noisy.map((d) => `${d.code} ${d.message}`), [], kind);
    }
});

test("project templates lint clean and parse like Project::deserialize", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { ContentIndex, projectFields } = await import("../../shared/content/index");
    const { parse } = await import("smol-toml");
    const { createEnv, lintProjectFiles } = await import("../../server/src/linter");
    const { RES } = await import("../server/helpers");
    const toml = t.projectToml({ name: "my_game", title: "My Game", basePacks: ["base"], permissions: ["network", "debugging"] });
    assert.deepEqual(projectFields(parse(toml) as Record<string, unknown>), {
        name: "my_game", title: "My Game", basePacks: ["base"], permissions: ["network", "debugging"],
    });
    assert.deepEqual(projectFields(parse(t.projectToml({ name: "x", title: "X", basePacks: [], permissions: [] })) as Record<string, unknown>).permissions, []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-project-"));
    try {
        fs.writeFileSync(path.join(dir, "project.toml"), toml);
        fs.writeFileSync(path.join(dir, "project_client.lua"), t.projectClientScript());
        fs.writeFileSync(path.join(dir, "start.lua"), t.projectStartScript());
        const index = new ContentIndex({ resPath: RES, roots: [dir] });
        const [project] = index.lintableProjects();
        assert.ok(project.clientScript && project.startScript);
        const noisy = [...lintProjectFiles(createEnv(index, {}, false), project).values()].flat();
        assert.deepEqual(noisy.map((d) => `${d.code} ${d.message}`), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
