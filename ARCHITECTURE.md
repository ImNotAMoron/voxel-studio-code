# Architecture

How `vscode-extension/` is put together. Start with [AGENTS.md](AGENTS.md)
for commands and rules, and [FEATURES.md](FEATURES.md) for the roadmap.

## Processes and bundles

```
VS Code extension host ── dist/extension.js (src/extension.ts)
   │  LanguageClient (IPC)          ▲ postMessage
   ▼                                │
vcls language server ── dist/server.js      webview (iframe) ── dist/webview.js
   (server/src/server.ts)                     (webview/src/main.ts, three.js)

CLI linter ── dist/cli.js (server/src/cli.ts), same rules as vcls
Engine ── VoxelCore(.exe) launched by the `voxelcore` task provider (src/run)
```

`esbuild.mjs` builds all four bundles: node targets as CJS with
`mainFields: ["module","main"]`, the webview as a browser IIFE.

## Layout

| Path | Area | Contents |
|---|---|---|
| `src/extension.ts` | integration | activation: calls every `register*`, starts the LanguageClient, sets the `voxelcore.hasPacks` context key |
| `src/packs.ts`, `src/packs.manifest.ts` | integration | finds workspace packs, the engine `res/` and the executable (`findWorkspacePacks`, `findResPath`, `findExecutable`, `pickPack`, `packRootOf`) |
| `src/scaffold/` | integration | *New Pack/Block/Item/Entity/Component* commands; `templates.ts` is pure |
| `src/run/` | integration | `voxelcore` TaskProvider (CustomExecution pseudoterminal), run commands, status bar; `userdir.ts`: pack junctions/symlinks + quick-world app script |
| `src/schemas/` | integration | TOML schema associations + pack-root `json.schemas` (workspace settings, with consent) |
| `src/lua/` | lua | configures `sumneko.lua` (`Lua.workspace.library` → `meta/`, globals, runtime); `settings.ts` is pure |
| `src/preview/` | preview | model preview panel, `.vec3` custom editor, texture resolver |
| `shared/vcm/parser.ts` | integration | VCM/VCA text → AST with offsets (mirrors `xml::VcmParser`) |
| `shared/models/` | preview | mesh builders `vcm.ts`, `obj.ts`, `vec3.ts` (ports of engine loaders), `protocol.ts` (host↔webview messages), `selection.ts` |
| `shared/content/` | server | `ContentIndex`: the workspace model of packs and units; `pack.ts` (id/dependency/version helpers, Levenshtein), `json.ts` (tolerant engine-JSON reader) |
| `server/src/` | server | `server.ts` (LSP), `cli.ts`, `linter.ts` (runs rules), `schemas.ts` (loads `schemas/` for keys/quick fixes), `rules/*` (lint rules + registry), `lua/` (script-kind spec, luaparse analysis), `vcm/spec.ts` (VCM/VCA element/attribute spec), `features/*` (completion, hover, definition, symbols, code actions) |
| `webview/src/` | preview | `viewer.ts` (three.js scene), `panel.ts` (side panel), `placeholders.ts` |
| `tools/` | — | `gen-schemas.mjs` + `schema-overlay/`, `gen-lua-meta.mjs`, `merge-contrib.mjs`, `vscode-smoke.mjs` |
| `schemas/`, `meta/` | generated | JSON Schemas + `catalog.json`; LuaLS `---@meta` files + `libraries.json`. **Committed** |
| `contrib/*.json` | each area | manifest fragments merged into `package.json` |
| `syntaxes/`, `languages/`, `snippets/`, `media/` | integration/preview | TextMate grammars, language config, snippets, webview CSS |
| `test/<area>/` | each area | node:test suites; `test/vscode/suite.js` runs inside a real VS Code |

## Data flow per feature

- **Schemas.** `tools/gen-schemas.mjs` reads the C++ loaders (the keys
  actually read, enums, defaults), `doc/en/*.md` (descriptions) and
  `tools/schema-overlay/*` (shapes). It writes `schemas/*.schema.json` +
  `catalog.json` + `contrib/schemas.json` (`jsonValidation`). The generator
  exits 1 if a loader key is missing from a schema; `--check` detects stale
  output. VS Code's JSON service then validates with no server. TOML schemas
  and pack roots outside `content/` go through `src/schemas/`.
- **Lua.** `tools/gen-lua-meta.mjs` parses `doc/en/scripting/**` signatures,
  cross-checks the `luaL_Reg` tables in `src/logic/scripting/lua/libs/*.cpp`,
  and writes `meta/*.lua` + `meta/libraries.json` (functions, plus the
  `states` each library exists in). `src/lua` points sumneko.lua at
  `meta/`. vcls adds what LuaLS can't express: per-script-kind callbacks,
  generator-state library restrictions, `require` resolution.
- **Linter (vcls).** `ContentIndex` scans packs: workspace folders with a
  pack `package.json`, plus engine `res/` as `core` and `res/content/*`. It
  is updated incrementally from didChange (overlay text) and watched-file
  events. `linter.ts` runs the `rules/*` per file and publishes
  diagnostics: open documents on change, the whole workspace on start and on
  file events. Rule ids: VC0001–0007 pack, VC0010–0013 silent drops,
  VC0020–0040 references, VC0050–0058 values, VC0060–0063 hygiene,
  VC0100–0106 Lua, VC0200–0209 VCM, VC0220–0226 VCA (`node dist/cli.js
  rules`). Settings: `voxelcore.lint.enable`, `voxelcore.lint.rules`
  (id → severity | `off`). Unknown JSON keys are reported by VS Code's JSON
  service in the editor, and by vcls only in the CLI.
- **Preview.** `src/preview` debounces `onDidChangeTextDocument` (50 ms),
  builds `ModelData` with `shared/models`, resolves textures
  (`src/preview/textures.ts`: pack → engine `res/` → `base`) into data URIs
  and posts `{type:"model"}`. Cursor moves post `{type:"highlight"}`; a
  click in the webview posts `{type:"select", span}` and the host reveals
  that range. Golden fixtures (`test/preview/fixtures/golden.json`) come
  from the engine's real loaders through the C++ dumper.
- **Run.** The `voxelcore` task (actions `run` / `quickWorld` / `headless`)
  links non-built-in workspace packs into `<userDir>/content/<id>`, writes a
  `--script` app script for quick worlds (`app.reconfig_packs`,
  `app.new_world` / `app.open_world`) and spawns the engine with
  `--res/--dir`. The default user dir lives in the extension's workspace
  storage.

## Client ↔ server contract

- Document selector: `file` scheme, languages `json`, `jsonc`, `toml`, `lua`,
  `vcm`, `vca`.
- `initializationOptions` and `workspace/configuration` (section
  `voxelcore`): `{ resPath, lint: { enable, rules } }`. `resPath` is
  auto-detected on the client side.
- File watcher: `**/*.{json,toml,lua,vcm,vca,txt,png,ogg,wav,obj,vec3,xml,vox}`.
- The server-side command `voxelcore.server.createTexture` is registered by
  the server through `executeCommandProvider`. The client must not register
  it.

## Engine facts the code relies on

- Content ids are `packid:name`; each block gets item `packid:name.item`.
- A definition file in `blocks/<sub>/x.json` gets the id `<sub>:x`
  (`ContentLoader.cpp::detect_defs`). Files starting with `_` are skipped.
- Unknown block/item properties are dropped by `res/scripts/post_content.lua`.
- Captions/locale keys: the name with `_` → space (`util::id_to_caption`).
- Attribute vectors without commas broadcast to all components; `shading` is
  on unless it's literally `off`.
- PNGs load bottom-up (`png.cpp`), equivalent to three.js `flipY = true`.
- Content sources: `world:content`, `user:content`, `project:content`,
  `res:content`. That's why runs link packs into `<userDir>/content`.

## Known gaps (as of the MVP)

- Linter: no XML layout or locale checks; hitbox checks ignore rotation;
  assets resolve against every indexed pack, not only declared
  dependencies; cross-file effects of an edit refresh on save.
- Lua: `require "pack:mod"` isn't resolvable by LuaLS (vcls handles
  definitions/diagnostics); event callbacks aren't in `meta/`; some return
  types are inferred.
- Preview: no VCM-XML models; clicking a box selects the `@box`, not the
  `@part`; texture lookup ignores pack dependencies.
- Not yet verified by hand in VS Code: visible texture rendering in the
  preview, and the sumneko.lua integration (the smoke test runs with an
  isolated extensions dir).
