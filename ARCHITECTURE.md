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
| `src/scaffold/` | integration | *New Project/Pack/Block/Item/Entity/Component/Layout* commands; `templates.ts` is pure |
| `src/run/` | integration | `voxelcore` TaskProvider (CustomExecution pseudoterminal), run commands, status bar; `userdir.ts`: pack junctions/symlinks + quick-world app script |
| `src/schemas/` | integration | TOML schema associations + pack-root `json.schemas` (workspace settings, with consent) |
| `src/lua/` | lua | configures `sumneko.lua` (`Lua.workspace.library` → `meta/`, globals, runtime); `settings.ts` is pure |
| `src/workspaceIndex.ts` | integration | the extension host's shared `ContentIndex` (previews, explorer, log mapping), rebuilt lazily after creates/deletes/saves; `onDidChange` event |
| `src/log/` | integration | engine log: `LogOutputChannel` "VoxelCore", `voxelcore-runtime` diagnostics, `latest.log` tail, link providers (output, task terminal, `latest.log`) |
| `src/debug/` | integration | `vcdbg.ts` (VC-DBG client: handshake, framing, `freePort`), `session.ts` (DAP adapter, pure: stepping emulation, values), `channels.ts` (one VC-DBG connection per engine, shared by runs and debug sessions), `index.ts` (debug type `voxelcore`, inline adapter, launch/attach host) |
| `src/hotreload/` | integration | `plan.ts` (saved file → asset / module / content / restart, engine paths), `bridge.ts` (dev bridge files), `index.ts` (save + watcher → channel, status bar) |
| `shared/assets/` | server | `png.ts` (pngjs decode/encode, nearest scaling, alpha kind, data-URI thumbnails), `audio.ts` (OGG/WAV durations) |
| `src/thumbnails/` | integration | gutter texture icons; `lines.ts` (pure: line → texture via the server's `extractRefs`, cached 32 px icons in global storage) |
| `src/explorer/` | Content / Dependencies / Engine tree views; `model.ts` is pure (categories, icons, captions, dependency rows, pack root folders); `decorations.ts` badges pack folders in VS Code's Explorer |
| `icons/` | generated | the *VoxelCore Content Packs* file icon theme (SVGs + theme JSON), output of `tools/gen-icons.mjs` |
| `shared/log/` | integration | `parse.ts` (log line format, streaming parser), `problems.ts` (entry → problem + target), `resolve.ts` (target → file range via `ContentIndex`), `links.ts` |
| `src/preview/` | preview | preview panel + `.vec3` custom editor (`index.ts`), texture resolver, `defs.ts` (pure: preview kind of a file, block/entity/skeleton inputs via `ContentIndex`) |
| `shared/layouts/` | generated + integration | `elements.json` (output of `tools/gen-layouts.mjs`: XML UI elements, attributes, types, Lua callback kinds), typed accessors in `index.ts`, `xml.ts`: the `xml::parse` port with offsets + `layoutContextAt` (completion context), and `values.ts`: models of the engine's attribute value readers |
| `syntaxes/vclayout-lua.injection.json` | generated | TextMate injection (into `text.xml`) for Lua in layout callback attributes; output of `tools/gen-layouts.mjs` |
| `shared/layouts/ids.ts`, `server/src/features/layoutDocument.ts`, `server/src/features/layoutAssets.ts` | shared / server | the ids `document.<id>` sees (getIndices model) and their completion/hover/definition in `.xml.lua`; preloaded texture names and binding names |
| `server/src/features/layoutNames.ts` | server | names shared by a layout and its script (functions, element ids): occurrences in both files for references and rename |
| `server/src/features/layoutLua.ts`, `server/src/lua/globals.ts` | server | Lua in layout callbacks (compiled like the engine), the layout's `.xml.lua` functions, pack-wide and engine-wide global names |
| `server/src/rules/project.ts` | server | project.toml rules VC0500–VC0502; the Lua side (VC0503 permissions, VC0504 bare require, project modules) is in `rules/lua.ts` |
| `server/src/rules/layout.ts`, `server/src/features/layout.ts` | server | layout rules VC0400–VC0416; layout completion, hover, outline, colours (`colorProvider`) |
| `shared/vcm/parser.ts` | integration | VCM/VCA text → AST with offsets (mirrors `xml::VcmParser`) |
| `shared/models/` | preview | mesh builders `vcm.ts`, `obj.ts`, `vec3.ts` (ports of engine loaders), `block.ts` (BlockLoader/ContentBuilder/BlocksRenderer port), `entity.ts` (EntityLoader + rigging), `assets.ts` (stored model names), `jsondef.ts` (JSON with spans), `protocol.ts` (host↔webview messages), `selection.ts` |
| `shared/content/` | server | `ContentIndex`: the workspace model of packs, units and projects; `project.ts` (project.toml fields, permissions, `requiredPermission`, `grantPermissionEdit`); `pack.ts` (id/dependency/version helpers, Levenshtein), `json.ts` (tolerant engine-JSON reader), `assemble.ts` (port of `PacksManager::assemble`: load order) |
| `server/src/` | server | `server.ts` (LSP), `cli.ts`, `linter.ts` (runs rules), `schemas.ts` (loads `schemas/` for keys/quick fixes), `rules/*` (lint rules + registry), `lua/` (script-kind spec, luaparse analysis), `vcm/spec.ts` (VCM/VCA element/attribute spec), `features/*` (completion, hover, definition, symbols, code actions; `references.ts` + `navigation.ts`: references, rename, workspace symbols, code lens) |
| `src/navigation.ts` | server | client side of references/rename: `voxelcore.showReferences` (code lens), explorer *Find VoxelCore References* / *Rename Content…* |
| `webview/src/` | preview | `viewer.ts` (three.js scene), `panel.ts` (side panel), `placeholders.ts` |
| `tools/` | — | `gen-schemas.mjs` + `schema-overlay/`, `gen-lua-meta.mjs`, `gen-layouts.mjs`, `merge-contrib.mjs`, `gen-icons.mjs`, `vscode-smoke.mjs` |
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
  Definitions (`blocks/`, `entities/`, `skeletons/` JSON, detected by
  `defs.ts previewKind`): the host keeps one `ContentIndex` (rescanned on
  file create/delete), and `DefResolver` reads the unit's files + `parent`
  chain + skeleton + model files (live editor text first) and calls
  `shared/models/block.ts` / `entity.ts`. Every file read is recorded as a
  dependency, so edits to a parent, skeleton or model refresh the view.
  `ModelData` carries optional `overlays` (boxes, spheres, labels),
  `block` / `entity` info and `shadingModel: "block"`; primitives may
  point into another `file`. Webview → host: `options` (variant,
  rotation → rebuild), `select` with `file`, `rendered` (scene stats, used
  by the smoke test through the internal `voxelcore.preview.inspect`).
  `test/preview/fixtures/blocks-golden.json` comes from `dump_blocks`.
- **Run.** The `voxelcore` task (actions `run` / `quickWorld` / `headless`)
  links non-built-in workspace packs into `<userDir>/content/<id>`, writes a
  `--script` app script for quick worlds (`app.reconfig_packs`,
  `app.new_world` / `app.open_world`) and spawns the engine with
  `--res/--dir`. The default user dir lives in the extension's workspace
  storage.

- **Engine log.** `EngineTerminal` (`src/run`) feeds the process stdout
  to an `EngineLog` session (`src/log`); otherwise `LogTail` polls
  `<userDir>/latest.log` (a truncated file or a new first line = a new
  session). `LogParser` splits entries (header `[E] date [module] msg` +
  continuation lines); `LogContext` remembers `loading pack [id]`;
  `problemOf` picks the target (specific loader patterns, else the
  innermost Lua location in the message, else the first traceback frame
  outside `core:`); `LogResolver` maps virtual paths (`pack:`,
  `user|world|project|res:content/<id>/`, `core:`, `script:`) to files
  and finds JSON values with jsonc-parser. Diagnostics are deduplicated with
  a `(×N)` counter, capped at 500, and cleared when a session starts.
- **References and rename.** `ReferenceIndex` (`server/src/features/references.ts`)
  extracts the reference strings of every pack file (JSON keys known to
  `jsonRefKind`, any full `pack:name` string in JSON/TOML/Lua except tag
  names, Lua calls known to `luaCallKind`, VCM `texture` attributes). It
  caches them per file by mtime, or by text for open documents. A symbol is
  the file a reference resolves to (`resolveRef`, same as go-to-definition),
  so two strings name the same symbol exactly when they resolve to the same
  file; `symbolOfFile` gives the symbol a definition or asset file defines.
  `planRename` rewrites the name segment of each reference (`namePosition`:
  after `:`/`/`, before `.`/end) and renames the files: sound variants,
  texture animation JSON, `.xml.lua` and unit overrides. For units it also
  renames the defaults they use by name (script, block item script,
  `ui-layout`, `skeleton-name`) and edits `content.json` in place. It refuses
  to rename a default on its own and refuses built-in packs.
  `navigation.ts` turns plans into `documentChanges` (text edits, then
  `RenameFile`s). Unit renames carry a `needsConfirmation` change annotation.
  `workspace/willRenameFiles` returns reference edits only, and skips files
  that our own rename edit is moving, because VS Code runs file
  participants for WorkspaceEdit renames too.
- **Debugger.** `registerDebug` returns a `DebugAdapterInlineImplementation`
  around `VoxelCoreDebugSession`. Launch: `prepareEngine` (src/run, shared
  with tasks) links the packs and builds the args, with `--dbg-server
  tcp:<free port>`. For quick worlds it writes the app script with
  `waitForDebugger`. The host spawns the engine, feeds stdout to the Debug
  Console and to an `EngineLog` session (Problems), connects `VcDbgClient`
  and registers the connection in `engineChannels` (owner `debugger`).
  `initialized` is sent after launch/attach, so `setBreakpoints` can map
  files to chunk names (`LogResolver.virtualPath`: `pack:rel`, `core:rel`,
  `script:<name>`). After `configurationDone` the host writes
  `export/vscode/debugger-ready` with the number of queued messages, and the
  app script ticks that many frames twice over before loading content.
  Stepping: every step sends `step-into-function`; `onPaused` keeps
  stepping while deeper than the start (over/out), skips
  `debugging.lua`, leaves engine code (`core:`/`res:`) with `resume`, and
  gives up after 400 lines. Values: `get-value` only at breakpoint pauses;
  the engine answers `resumed`, `value`, then a reason-less `paused`, which
  `absorbPauses` swallows. Attach adopts the run's channel (`owner`
  `debugger`); on detach, `release` hands it back to the keeper.
- **Hot reload.** Runs (`run`, `quickWorld`) get `--dbg-server` when
  `voxelcore.hotReload.enable` is on, and `keepConnection` registers a
  keeper channel that answers every `paused` with `resume`. On save (or a
  watcher change for binary assets), `reloadActionFor` decides:
  - asset: one VC-DBG `hot-reload` per engine path;
  - module / content: a request appended to `export/vscode/bridge.json`,
    which the quick-world script polls every 10 frames and answers in
    `bridge-ack.json`;
  - restart: a status message.
- **Hovers with assets.** `hover` (server/src/features/language.ts)
  resolves the reference as before, then `assets.ts` adds details: a
  texture thumbnail data URI (cached by mtime), the `texture-faces` table,
  sound variants with durations, model facts. Captions, `gui.str` keys and
  locale keys get `translationsHover` (`shared/content/locale.ts
  translations`: res/texts, then every pack, the last one wins).
  Command links use client commands (`voxelcore.openFile`,
  `voxelcore.previewFile`). The client's `provideHover` middleware trusts
  only those two.
- **Locale files.** Role `locale` = `<pack>/texts/<lang>.txt` (the
  engine's own res/texts isn't linted). `parseLocale` mirrors
  `BasicParser`; rules in `server/src/rules/locale.ts`; VC0303/VC0304 carry
  `data.stubs` for the code action.
- **Content explorer.** Tree providers read `workspaceIndex` on demand and
  refresh on its `onDidChange`; the Engine view refreshes on
  `EngineLog.onDidChangeSessions` and settings changes. Internal commands
  `voxelcore.explorer.inspect`, `voxelcore.log.inspect` and
  `voxelcore.log.feed` exist for the smoke test.
- **Explorer icons.** Pack roots are found through `workspaceIndex`
  (`packRootFolders`) and decorated, because an icon theme can only match
  folder *names*. The icon theme is generated; `test/integration/icons.test.ts`
  fails when `icons/` is stale or an SVG is invalid.

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
- Custom requests: `voxelcore/symbolReferences {uri}` → `Location[]`;
  `voxelcore/renameSymbol {uri, newName?}` → `{name, id, kind}` without
  `newName`, else `{edit}` or `{error}`. Code lenses use the client-side
  command `voxelcore.showReferences(uri, position, locations)`, with LSP JSON
  arguments that the client converts.

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

- Layout rename from a `.xml.lua` competes with the Lua extension's rename provider; from the `.xml` side ours is the only one; callback names are checked against the `.xml.lua` on disk (re-checked on save, not while the script is being typed); hitbox checks ignore rotation;
  assets resolve against every indexed pack, not only declared
  dependencies; cross-file effects of an edit refresh on save.
- Lua: `require "pack:mod"` isn't resolvable by LuaLS (vcls handles
  definitions/diagnostics); event callbacks aren't in `meta/`; some return
  types are inferred.
- Preview: no VCM-XML models; clicking a box selects the `@box`, not the
  `@part`; model texture lookup ignores pack dependencies (definition
  previews use the content index order). Block preview: no AO, neighbour
  culling or X-sprite jitter. Entity preview: rest pose only, no skeleton
  texture overrides.
- Log: client-only errors (assets, shaders, audio) are matched only by the
  generic `<vpath>: msg` pattern and have no recorded fixtures; no
  `$voxelcore` problem matcher.
- References: locale keys, `document.<id>` uses and generator structure/fragment
  names aren't searched. Strings built at runtime (`"steps/"..name`) can't
  be found. Rename doesn't update the locale key of a unit's default
  caption (`id_to_caption`). A file rename from
  the Explorer updates references but doesn't move a unit's default
  script/layout (F2 and *Rename Content…* do).
- Debugger: no conditional / log breakpoints, set variable or expression
  evaluation (VC-DBG has none). Tables expand only at breakpoint pauses.
  A step over a long call costs one engine frame per line and gives up
  after 400. Unverified lines are still shown as verified (the engine
  doesn't report it). The quick-world wait is tested headless only.
- Hot reload: module/content reload needs the quick-world script (not *Run
  engine* or an external engine). A visible asset change after
  `hot-reload` was checked only through the engine log ("enqueued to
  reload: 1").
- Hovers: images are data URIs; how big hovers render wasn't checked by eye. Model hovers have no rendered thumbnail. Layout textures and `@key` texts are covered since §3.7 steps 8–10.
- Explorer: no delete action; textures of other atlases
  than `blocks`/`items` aren't used as icons for entities.
- Not yet verified by hand in VS Code: visible texture rendering in the
  preview, and the sumneko.lua integration (the smoke test runs with an
  isolated extensions dir).
