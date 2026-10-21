# Architecture & contracts (MVP)

Implementation guide for `vscode-extension/`. The feature plan is
[FEATURES.md](FEATURES.md); this file pins down **who owns what** and the
interfaces between parts so they can be built in parallel.

MVP = the P0 features of FEATURES.md: §3.1 schemas, §3.2 Lua API, §3.3 pack
linter, §3.4 VCM/VCA support, §3.8 snippets + scaffolding, §4.1 run in engine,
§5.1 model preview.

## Layout and ownership

| Path | Owner / area | Contents |
|---|---|---|
| `package.json`, `esbuild.mjs`, `tsconfig.json` | integration | manifest; **do not edit from other areas**: put manifest additions in `contrib/<area>.json` (see below) |
| `src/extension.ts` | integration | activation; calls each area's `register*` function |
| `src/run/`, `src/scaffold/` | integration | engine runner TaskProvider, pack linking, scaffolding commands |
| `syntaxes/`, `languages/`, `snippets/`, `templates/` | integration | TextMate grammars, language configs, snippets, scaffold templates |
| `shared/vcm/parser.ts` | integration (done) | VCM/VCA text → AST with offsets. Read-only for others; report bugs |
| `tools/gen-lua-meta.mjs`, `meta/`, `src/lua/` | **lua** | generated LuaLS `---@meta` files + sumneko.lua configuration |
| `tools/gen-schemas.mjs`, `schemas/` | **schemas** | generated JSON Schemas + `schemas/catalog.json` |
| `shared/models/`, `webview/`, `src/preview/` | **preview** | mesh builders (VCM, OBJ, vec3), three.js webview, preview panel controller |
| `server/src/`, `shared/content/` | **server** | `vcls` language server + CLI linter, workspace content index |
| `test/<area>/*.test.ts` | each area | unit tests, run with `npm test` (`node --import tsx --test`) |

## Manifest fragments

Each area may add `contrib/<area>.json` with this shape:

```json
{
  "contributes": { "commands": [...], "configuration": { "properties": {...} }, "...": [...] },
  "activationEvents": ["onCommand:..."],
  "dependencies": { "pkg": "^1.0.0" }
}
```

`npm run contrib` (`tools/merge-contrib.mjs`) merges all fragments into
`package.json`. Arrays are concatenated, objects merged, and
`configuration.properties` merged. Only `contrib/integration.json` may set
top-level fields other than the three above.

## Build & test

- `npm run build`: esbuild bundles `src/extension.ts` → `dist/extension.js`,
  `server/src/server.ts` → `dist/server.js`, `server/src/cli.ts` →
  `dist/cli.js`, and `webview/src/main.ts` → `dist/webview.js`.
- `npm run typecheck`: strict TypeScript for host code and the webview.
- `npm test`: unit tests. They must not need VS Code; keep `vscode` imports
  out of `shared/` and `server/`.
- `npm run gen`: regenerates `schemas/` and `meta/` from the engine repo. The
  generators locate the engine root as `..` (this folder lives in the
  VoxelCore repo) or via the `VOXELCORE_ROOT` env var. **Generated files are
  committed**, so the extension works without the engine sources.

Installed packages: `three`, `jsonc-parser`, `smol-toml`, `luaparse`,
`pngjs`, `vscode-languageclient`, `vscode-languageserver`,
`vscode-languageserver-textdocument`; dev: `typescript`, `esbuild`, `tsx`,
`@types/*`, `@vscode/vsce`. Ask integration before adding others.

## Interfaces

### Area entry points (called from `src/extension.ts`)

```ts
// src/lua/index.ts
export function registerLua(context: vscode.ExtensionContext): void;
// src/preview/index.ts
export function registerPreview(context: vscode.ExtensionContext): void;
// language client lives in src/extension.ts; server is dist/server.js (stdio/IPC)
```

### VCM AST (`shared/vcm/parser.ts`)

`parseVcm(text) → { elements: VcmElement[], errors }`. Each element has `tag`,
`attributes[] {name, value, kind, nameSpan, valueSpan}`, `children`, and
spans as **string offsets**. Values match what the engine sees: quotes and
outer parens are removed. Number lists are parsed with `parseNumbers`.

Engine attribute semantics that consumers must respect (`src/coders/xml.cpp`):
- `asVec3` / `asVec4`: a value **without commas is broadcast** to all
  components (`scale 2` = `(2,2,2)`). With commas, exactly 3 / 4 parts are
  required.
- `shading`: anything other than the literal `off` means on.

### Content index (`shared/content/`, owned by server)

The workspace model of packs is used by the server, and later by the
extension host (preview texture resolution). Minimum API:

```ts
interface PackInfo { id: string; root: string /* abs fs path */; title?: string; dependencies: string[]; builtin: boolean }
interface ContentIndex {
  packs: Map<string, PackInfo>;
  resolveTexture(atlas: "blocks"|"items"|string, name: string, fromPack?: string): string | undefined; // abs path to png
  resolveModel(name: string, fromPack?: string): string | undefined;
  // blocks, items, entities, materials, skeletons, components, sounds, user props …
}
```

Packs: every folder with a pack-shaped `package.json` (has `id`) in the
workspace, plus the engine `res/` (the `core` pack) and `res/content/*`
(built-in packs such as `base`). `res/` is found from the
`voxelcore.resPath` setting, else by auto-detection (a workspace folder or an
ancestor containing `res/content/base/package.json`).

### Settings (namespace `voxelcore`)

| Setting | Owner | Meaning |
|---|---|---|
| `voxelcore.resPath` | integration | engine `res/` folder |
| `voxelcore.executable` | integration | VoxelCore executable |
| `voxelcore.userDir` | integration | dev user dir for runs |
| `voxelcore.configureLua` | lua | `ask` / `always` / `never` |
| `voxelcore.lint.enable` | server | boolean |

The client passes `resPath` to the server in `initializationOptions` and in
`workspace/didChangeConfiguration`.

## Engine facts every area needs

- Content ids are `packid:name`; a block automatically has item
  `packid:name.item`.
- Definition files: `blocks|items|entities/<name>.json`. Subfolders give ids
  `<subdir>:<name>`? **No.** See `ContentLoader.cpp::detect_defs`: a subfolder
  name becomes a prefix inside the pack's name (`detect_defs(file, name, …)`).
  Verify before relying on it. Files starting with `_` are skipped.
- Unknown block/item properties are silently dropped by
  `res/scripts/post_content.lua`, which is why the linter matters.
- Texture names: block textures live in `textures/blocks/<name>.png` (atlas
  `blocks`), items in `textures/items/` (atlas `items`), and other textures
  are addressed by path (`entities/tireman:face_0` = atlas `entities/tireman`).
- PNGs are loaded bottom-up by the engine (`src/coders/png.cpp`), which
  affects UV orientation.
