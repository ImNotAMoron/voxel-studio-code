import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CatalogEntry, packRootJsonSchemas, tomlAssociations } from "../../src/schemas/associations";

const catalog: CatalogEntry[] = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../schemas/catalog.json"), "utf8")
);
const url = (v: string) => (file: string) => `file:///ext-${v}/schemas/${file}`;

test("TOML associations cover every TOML schema and replace only our old entries", () => {
    const existing = {
        "^mine\\.toml$": "https://example.com/mine.json",
        "^old$": "file:///ext-0/schemas/generator.schema.json",
    };
    const result = tomlAssociations(catalog, url("1"), existing);
    assert.equal(result["^mine\\.toml$"], "https://example.com/mine.json");
    assert.equal(result["^old$"], undefined);
    const tomlSchemas = catalog.filter((e) => e.format === "toml").map((e) => e.schema);
    assert.ok(tomlSchemas.length > 0);
    for (const schema of tomlSchemas) {
        assert.ok(Object.values(result).includes(`file:///ext-1/schemas/${schema}`), schema);
    }
    const generator = Object.entries(result).find(([, u]) => u.endsWith("/generator.schema.json"))!;
    assert.match("file:///c%3A/w/packs/backrooms/generators/level0.toml", new RegExp(generator[0]));
});

test("pack-root json.schemas entries are rebuilt idempotently", () => {
    const user = { fileMatch: ["/x.json"], url: "./x.schema.json" };
    const first = packRootJsonSchemas(["packs/backrooms", ""], url("1"), [user]);
    assert.deepEqual(first[0], user);
    assert.deepEqual(first[1].fileMatch, ["/package.json", "/packs/backrooms/package.json"]);
    assert.deepEqual(first[2].fileMatch, ["/content.json", "/packs/backrooms/content.json"]);
    const second = packRootJsonSchemas(["packs/backrooms", ""], url("2"), first);
    assert.equal(second.length, 3);
    assert.ok(second[1].url.startsWith("file:///ext-2/"));
    assert.deepEqual(packRootJsonSchemas([], url("1"), first), [user]);
});
