// Merges contrib/*.json manifest fragments into package.json.
// Arrays are concatenated (deduplicated by `id`/`command`/`language`/JSON
// value), objects are merged recursively. `contributes` is rebuilt from the
// fragments each time, so removing a fragment entry removes it from the manifest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = path.join(root, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const contribDir = path.join(root, "contrib");

const keyOf = (item) =>
    item && typeof item === "object"
        ? item.id ?? item.command ?? item.language ?? item.viewType ?? item.type ??
          JSON.stringify(item)
        : JSON.stringify(item);

function merge(target, source) {
    for (const [key, value] of Object.entries(source)) {
        const current = target[key];
        if (Array.isArray(value)) {
            const list = Array.isArray(current) ? current : [];
            const seen = new Set(list.map(keyOf));
            for (const item of value) {
                const k = keyOf(item);
                if (!seen.has(k)) {
                    list.push(item);
                    seen.add(k);
                }
            }
            target[key] = list;
        } else if (value && typeof value === "object") {
            target[key] = merge(current && typeof current === "object" ? current : {}, value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

const files = fs.existsSync(contribDir)
    ? fs.readdirSync(contribDir).filter((f) => f.endsWith(".json")).sort()
    : [];
// integration first so its ordering wins for shared menus
files.sort((a, b) => (a === "integration.json" ? -1 : b === "integration.json" ? 1 : 0));

pkg.contributes = {};
const activation = new Set(pkg.activationEvents ?? []);
for (const file of files) {
    const fragment = JSON.parse(fs.readFileSync(path.join(contribDir, file), "utf8"));
    if (fragment.contributes) merge(pkg.contributes, fragment.contributes);
    for (const e of fragment.activationEvents ?? []) activation.add(e);
    if (fragment.dependencies) pkg.dependencies = { ...pkg.dependencies, ...fragment.dependencies };
    if (file === "integration.json") {
        for (const [k, v] of Object.entries(fragment)) {
            if (!["contributes", "activationEvents", "dependencies"].includes(k)) pkg[k] = v;
        }
    }
}
pkg.activationEvents = [...activation];
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`merged ${files.length} fragment(s): ${files.join(", ")}`);
