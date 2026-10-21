# VoxelCore Content-Pack Tooling for VS Code — Feature Plan

Status: **planning (part 1 — preparation)**. Nothing here is implemented yet.
This file lists what a content-pack developer needs from the editor, and
explains how each feature will be built with the VS Code extension API, with
pointers to the engine code that is the source of truth for it.

This is the VS Code port of [`../zed-extension/FEATURES.md`](../zed-extension/FEATURES.md).
The language server and debug adapter described here are editor-independent
(TypeScript on Node), so a Zed extension can later reuse them as a thin client.

Target engine: VoxelCore **v0.32** (`src/constants.hpp`).

---

## 0. Who we are building for

A modder writes a **content pack**: a folder with `package.json` plus JSON/TOML
definitions, Lua scripts, XML UI layouts, VCM/VCA/OBJ/vec3 models, PNG
textures, OGG sounds and locale `.txt` files (see `doc/en/content-packs.md`).
Today the modder's loop looks like this:

1. Edit JSON by hand from the docs. Typos are **silently ignored**:
   `res/scripts/post_content.lua` deletes any block/item property it doesn't
   recognize. `"emision": [15,0,0]` gives no error. The light just doesn't
   work.
2. Copy or link the pack into a content source (`user:content`,
   `res:content`, …). The engine does **not** scan arbitrary folders such as
   `packs/`.
3. Start the game, enable the pack, create a world and look at the result.
4. Read `latest.log` to find out what broke.

Every feature below shortens one of these steps. The real pain points from
building `packs/backrooms` are the reference: 3×3 textures split across hidden
helper blocks, lighting and shading tuning, a player-size workaround, and the
fact that the pack must be copied into a content source before it can run.

---

## 1. VS Code capabilities we rely on

VS Code extensions are Node.js (TypeScript) modules with a declarative
`package.json` manifest (`contributes`) and a runtime API (`vscode`).

| Capability | Use here |
|---|---|
| `contributes.languages` + `contributes.grammars` (TextMate) | VCM, VCA, VoxelCore locale files; Lua injection into XML attributes |
| `contributes.jsonValidation` | JSON Schemas for definition files, **no server needed** for basic completion/validation |
| `contributes.tomlValidation` (provided by the *Even Better TOML* extension) | Schemas for generator/config TOML files |
| Language Server Protocol (`vscode-languageclient` / `vscode-languageserver`) | Main intelligence: `vcls` (VoxelCore Language Server) |
| **Webviews** (`createWebviewPanel`, `CustomTextEditorProvider`, `WebviewViewProvider`) | Model / block / animation / texture / generator previews **inside the editor** |
| Debug adapters (`contributes.debuggers`, `DebugAdapterInlineImplementation`) | Lua debugging over the engine's VC-DBG protocol, in-process |
| Tasks (`contributes.taskDefinitions`, `TaskProvider`, `problemMatchers`) | "Run pack in engine", "Validate pack", "Package pack" |
| Testing API (`vscode.tests.createTestController`) | Pack test explorer (headless engine tests) |
| Tree views (`contributes.views`, `TreeDataProvider`) | Content explorer: blocks, items, entities, dependencies |
| Output channels, status bar, notifications, quick picks, `FileSystemWatcher` | Engine logs, connection status, scaffolding wizards, hot reload |
| `contributes.snippets`, `contributes.walkthroughs` | Templates; "Getting started with VoxelCore modding" |
| `contributes.configurationDefaults` / `workspace.getConfiguration().update` | Configure the Lua language server (sumneko.lua) for engine APIs |

Constraints worth knowing up front:
- **Webviews are sandboxed iframes.** They talk to the extension only via
  `postMessage`. They may load local files only through `asWebviewUri` and
  `localResourceRoots`, and they need a strict Content-Security-Policy.
  WebGL works, so three.js works.
- Webview state is lost when the panel is hidden unless
  `retainContextWhenHidden` is set (it costs memory) or state is saved with
  `getState`/`setState`. Previews use `setState` + `WebviewPanelSerializer`
  so they survive reloads.
- TextMate grammars are regex-based. They are good for highlighting but
  can't do semantic checks. Structure-aware work (outline, validation) uses
  a real parser in `vcls`: `web-tree-sitter` running the `tree-sitter-vcm`
  grammar compiled to WASM.
- Remote/WSL/Containers: the extension declares `"extensionKind":
  ["workspace"]` because it launches the engine and reads pack files on the
  machine where the workspace lives. Webviews still render on the UI side.

### Resulting architecture

```
vscode-extension/
  package.json              # manifest: contributes (languages, grammars, jsonValidation,
                            #   tomlValidation, debuggers, customEditors, views, commands,
                            #   taskDefinitions, problemMatchers, snippets, walkthroughs, configuration)
  src/                      # extension host (client)
    extension.ts            # activation, LanguageClient, command registration
    preview/                # webview panel controllers + serializers
    debug/                  # vc-dap: inline DAP <-> VC-DBG bridge
    tasks/ tests/ views/    # TaskProvider, TestController, TreeDataProviders
  server/                   # vcls — language server (vscode-languageserver, Node)
  shared/                   # code shared by server, client and webviews:
                            #   content index, VCM/VCA parser + mesh builder, ID resolver
  webview/                  # preview app (three.js + small UI), bundled with esbuild
  syntaxes/                 # *.tmLanguage.json (vcm, vca, vclang, xml-lua injection)
  grammars/tree-sitter-vcm/ # grammar source + prebuilt .wasm (used by vcls)
  schemas/                  # JSON Schemas generated from engine sources + docs
  meta/                     # generated LuaLS `---@meta` API definitions
  snippets/
  preview-project/          # VoxelCore project used for engine-accurate preview (§5.2)
  tools/                    # generators that read the engine repo and emit schemas/meta
  test/                     # @vscode/test-electron integration tests + unit tests
```

Why TypeScript everywhere:
- No per-platform binaries. Node ships with VS Code.
- The VCM mesh builder in `shared/` runs in both the server (validation,
  thumbnails) and the webview (rendering), so they can't disagree.
- Zed can still run `vcls` through its Node runtime
  (`zed_extension_api::node_binary_path` / `npm_install_package`).

---

## 2. Feature list at a glance

Priority: **P0** = MVP, **P1** = strongly wanted, **P2** = nice to have.

| # | Feature | Pri | Where it runs |
|---|---|---|---|
| 3.1 | JSON/TOML schemas (completion, hover docs, validation) for every definition file | P0 | `jsonValidation` + vcls |
| 3.2 | Lua API intelligence (engine libraries, events, per-script-kind globals) | P0 | sumneko.lua config + meta + vcls |
| 3.3 | Pack linter (cross-file references, silent-drop detection, docs pitfalls) | P0 | vcls |
| 3.4 | VCM / VCA language support (syntax, outline, validation, completion) | P0 | TextMate + vcls (tree-sitter WASM) |
| 3.5 | Cross-reference navigation (go-to-definition, find references, rename) | P1 | vcls |
| 3.6 | Locale files (`texts/*.txt`) support and missing-translation checks | P1 | TextMate + vcls |
| 3.7 | XML UI layout support (elements, attributes, `.xml.lua` binding) | P1 | vcls |
| 3.8 | Snippets, scaffolding wizards and walkthrough | P0 | snippets + commands |
| 3.9 | Texture and asset hover previews | P1 | vcls (hover markdown) |
| 3.10 | Content explorer sidebar | P1 | tree views |
| 4.1 | Run the pack in the engine (one command, no manual copying) | P0 | TaskProvider |
| 4.2 | Live hot reload (assets, Lua modules) | P1 | client → VC-DBG `hot-reload` |
| 4.3 | Engine log → Problems panel + Output channel | P1 | problem matchers + vcls |
| 4.4 | Lua debugger (breakpoints, stepping, locals) | P1 | inline DAP |
| 4.5 | Pack test explorer | P2 | TestController |
| 4.6 | Console / command bridge (`--stdin-cmd`) | P2 | client |
| 5.1 | Model preview (VCM / OBJ / vec3) beside the source, live on every keystroke | P0 | webview |
| 5.2 | Engine-accurate block/model preview (real renderer) | P1 | VoxelCore + preview-project |
| 5.3 | Skeleton + VCA animation preview with timeline | P1 | webview |
| 5.4 | Block preview (texture-faces, hitboxes, rotation profiles, variants) | P1 | webview |
| 5.5 | Texture tiling / multi-block texture helper | P2 | webview + code action |
| 5.6 | Particle preset preview | P2 | webview / engine preview |
| 5.7 | World-generator preview (heightmap / biome map) | P2 | headless engine + webview |
| 6.x | Formatting, packaging, dependency checks, docs lookup, Copilot/LM tools | P1–P2 | vcls / client |

---

## 3. Editing intelligence

### 3.1 JSON/TOML schemas for definition files — P0

**What the user gets:** completion of property names and enum values, hover
docs (taken from `doc/en/*.md`), and red squiggles for unknown keys, wrong
types or wrong array lengths in:

| File pattern | Engine loader | Doc |
|---|---|---|
| `package.json` (pack root, next to `content.json` or `blocks/`) | `content/ContentPack.cpp` | `content-packs.md` |
| `blocks/**/*.json` | `content/loading/BlockLoader.cpp` | `block-properties.md` |
| `items/**/*.json` | `content/loading/ItemLoader.cpp` | `item-properties.md` |
| `entities/**/*.json` | `content/loading/EntityLoader.cpp` | `entity-properties.md` |
| `skeletons/*.json` | `objects/rigging.*` | `rigging.md` |
| `block_materials/*.json` | `voxels/Block.cpp` (`BlockMaterial::deserialize`) | — (base pack examples) |
| `generators/*.toml`, `*.files/biomes.toml`, `structures.toml` | `content/loading/GeneratorLoader.cpp` | `world-generator.md` |
| `preload.json` | `assets/AssetsLoader.cpp::processPreloadConfig` | `assets-preload.md` |
| `resources.json`, `resource-aliases.json` | `ContentLoader.cpp` | `resources.md` |
| `config/defaults.toml`, `bindings.toml`, `user-props.toml`, `tags.toml` | `ContentLoader.cpp`, `post_content.lua` | `content-packs.md` |
| `presets/weather/*.json`, `presets/text3d/*.json` | `world/Weather.*`, `presets/` | `3d-text.md`, `libgfx-weather.md` |
| `particles` objects (inside blocks, presets) | `graphics/render/ParticlesRenderer`, `presets/ParticlesPreset` | `particles.md` |
| `project.toml` | `devtools/Project.cpp` | `agents/content-and-io.md` |
| `content.json` | `ContentLoader::fixPackIndices` | **read-only** warning (auto-generated) |

**How:**
- **Schemas are generated, not handwritten.** `tools/gen-schemas` does three
  things:
  1. Parses the loaders for the keys they actually read
     (`root.at("…")`, `root.has("…")`, `root["…"]`). This already surfaces
     keys the docs don't cover: `parent`, `overlay-texture`,
     `surface-replacement`, `biomes-interpolation`, `heights-interpolation`.
  2. Parses `doc/en/*.md` (and `doc/ru/` for Russian hover text) for
     descriptions, enum values (`rotation`: `none|pipe|pane|stairs|ladder`,
     `model`: `block|none|X|aabb|custom`, `culling`, `body-type`,
     `uses-display`, `grounding-behaviour`, `icon-type`, …) and defaults.
  3. Merges a small hand-maintained overlay with types and shapes:
     `hitbox` = 6 numbers, `emission` = 3 ints 0..15, `texture-faces` = 6
     strings, `size` = 3 ints, `fields` types `int8…float64|char`,
     `convert-strategy`, and so on.

  Output: JSON Schema draft-07 files in `schemas/`, versioned per engine
  release. Descriptions go into `markdownDescription` so VS Code renders
  them with formatting.
- **Two layers:**
  1. *Static layer, free:* `contributes.jsonValidation` maps file globs to
     the schemas, and VS Code's built-in JSON language service does
     completion, hover and validation. Everything works even if vcls fails
     to start. TOML files get the same through `contributes.tomlValidation`
     when *Even Better TOML* is installed (declared in
     `extensionDependencies` or recommended via the walkthrough).
  2. *Dynamic layer, vcls:* rules a static schema can't express:
     - **Namespaced user properties** (`"base:durability"`) are valid only
       if some loaded pack declares them in `config/user-props.toml`
       (combined with `file.read_combined_object`). vcls reads these files
       across the workspace and the engine `res/` folder. The schema allows
       `^[a-z_]+:.*` keys; vcls reports the undeclared ones.
     - **`@append` method suffix** (`"tags@append": [...]`): accept
       `<known-list-prop>@append` and reject unknown methods
       (`ContentLoader.cpp::process_method` throws on them).
     - **`state-based.variants[]`** allows only `model`, `model-name`,
       `texture`, `texture-faces`, `model-primitives`.
     - **Mutual exclusion**: `texture` vs `texture-faces`; `hitbox` vs
       `hitboxes`.
     - Completion of string IDs (textures, materials, models, items) from
       the content index (§3.5). The JSON language service can't do this,
       so vcls registers a completion provider for the same files.
- `jsonValidation` globs are path-based and can't tell whether a folder is
  a content pack. A false match on an unrelated `blocks/*.json` is
  possible. To prevent this, the static mapping is only enabled when the
  workspace contains a pack, using a `workspaceContains:**/package.json`
  activation event plus a check for a pack-shaped `package.json`. Otherwise
  vcls applies schemas programmatically through
  `json.schemas` configuration updates.

### 3.2 Lua API intelligence — P0

**What the user gets:** completion and signatures for all ~45 engine
libraries (`block`, `world`, `entities`, `gui`, `gfx.*`, `file`, …), the
stdlib extensions (`table.*`, `string.*`, `math.*`, `bit.*`, `sleep`,
`await`), `core:` modules, and **the right globals for the right file**.

**How:**
1. **Generated LuaLS definitions** (`meta/*.lua`, `---@meta`). These come
   from `doc/en/scripting/builtins/lib*.md`, `scripting/extensions.md`,
   `ecs.md`, `ui.md`, `world-generator.md` (Heightmap, VoxelFragment). The
   docs use a consistent signature style, for example
   `block.set(x: int, y: int, z: int, id: int, states: int, noupdate: boolean=false)`
   and `-> type`, with `-- comment` lines above each signature, so a small
   parser converts them into `---@param` / `---@return` annotations. Type
   mapping: `vec3` → `number[]`, `int` → `integer`, `str` → `string`,
   `[optional] x` → `x?`. A cross-check step lists every `luaL_Reg` entry in
   `src/logic/scripting/lua/libs/*.cpp` and reports functions that exist but
   have no docs, and docs entries that no longer exist.
2. **Hooking into the Lua language server** (`sumneko.lua`, declared in
   `extensionDependencies`):
   - On activation in a pack workspace, the extension updates workspace
     settings through `workspace.getConfiguration('Lua').update(...)`:
     `Lua.workspace.library` ← the extension's `meta/` folder (absolute
     path from `context.extensionUri`), `Lua.runtime.version` = `"LuaJIT"`,
     `Lua.diagnostics.globals` ← engine globals, and `Lua.runtime.path`
     entries for `modules/?.lua`.
   - The extension asks before writing to `.vscode/settings.json` the
     first time. A setting `voxelcore.configureLua` (`ask|always|never`)
     controls this.
   - Alternative for users who prefer a portable config: a command
     *VoxelCore: Write .luarc.json*.
3. **Per-script-kind environments.** LuaLS can't vary globals per file
   pattern, so vcls registers as a second Lua language server (document
   selector `{language: "lua", pattern: "**/{scripts,modules,layouts,generators}/**"}`).
   It adds its own Lua diagnostics and completions, using a tree-sitter Lua
   parse and the file's role (from `agents/scripting.md`):

   | File | Extra globals / callbacks | Forbidden |
   |---|---|---|
   | `scripts/<block>.lua` | `on_placed`, `on_broken`, `on_interact`, `on_update`, `on_random_update`, `on_block_tick`, `on_blocks_tick`, `on_block_present`, `on_block_removed`, … | — |
   | `scripts/<item>.lua` | `on_use`, `on_use_on_block`, `on_block_break_by` | — |
   | `scripts/world.lua` | `on_world_open/save/tick/quit`, `on_block_*`, `on_chunk_*`, `on_entity_*`, `on_inventory_*`, `on_player_tick` | — |
   | `scripts/hud.lua` | `on_hud_open/render/close`, `on_inventory_interact` | — |
   | `scripts/content.lua` | `on_scripts_loading`, `on_content_loaded` | — |
   | `scripts/components/*.lua` | `entity`, `ARGS`, `SAVED_DATA`, `on_update`, `on_render`, `on_sensor_enter`, … | — |
   | `layouts/*.xml.lua` | `document`, `on_open`, `on_close`, `on_progress` | — |
   | `generators/*.files/script.lua` | `SEED`, `__DIR__`, `__FILE__`, `Heightmap`, `VoxelFragment`, `generate_heightmap`, `generate_biome_parameters`, `place_structures`, … | `world`, `player`, `entities`, `gui`, `hud`, `audio`, `ffi`, `input`, `inventory`, `network`, … (only the pure libraries from `lua_engine.cpp::create_libs` are allowed) |
   | `modules/**/*.lua` | `PACK_ID`, `PACK_ENV` | — |

   Diagnostics include:
   - a misspelled callback (`on_place` instead of `on_placed`): "this
     function will never be called by the engine";
   - a generator script calling `world.*`: an error, because the library is
     missing in the generator state;
   - a module that doesn't `return` a table;
   - writes to `_G` from pack code (the docs warn against this);
   - deprecated calls. The list comes from `res/modules/internal/deprecated.lua`.

   Completion inside these files offers the callback stubs with documented
   parameters (`function on_placed(x, y, z, playerid)`).
4. **`require` resolution.** `require "pack:path/mod"` and the bare
   `require "mod"` (same pack) resolve to `<pack>/modules/path/mod.lua`,
   with go-to-definition (vcls `DefinitionProvider`), completion of module
   paths and an error for a missing module. `core:internal/*` is flagged as
   locked.
5. **String-ID completion inside Lua**: block/item/entity IDs in
   `block.index("…")`, `item.index("…")`, `entities.spawn("…")`, sound names
   in `audio.play_sound("…")`, texture names, layout IDs for `hud.open_block`
   and similar calls. The ID index is the same one described in §3.5.

### 3.3 Pack linter — P0

A rule engine inside vcls that publishes diagnostics on open, change and
save, plus a CLI mode (`npx vcls lint <pack>`) for CI. Each rule cites the
doc or source line it comes from: `Diagnostic.code` is an object with a
`target` URI linking to the doc section, so the rule ID is clickable in the
Problems panel. Initial rules:

**Pack and identity**
- `package.json`: `id` matches `^[A-Za-z_][A-Za-z0-9_]{1,23}$`, isn't a
  reserved name (`ContentPack::RESERVED_NAMES`: `res`, `core`, `user`,
  `world`, `project`, …), and the folder name equals the id.
- `version` format; dependency syntax (`!`/`?`/`~` prefix, `@>=1.0`
  operators); dependencies that can't be found in the configured content
  sources.
- Missing `icon.png`, or one that isn't 128×128 (hint).

**Silent drops**
- An unknown property in a block/item definition. The engine removes it in
  `post_content.lua` with no message, so this is the most valuable rule.
- `"pack:prop"` that isn't declared in any `config/user-props.toml`.
- Files starting with `_` in `blocks/` and the other definition folders are
  skipped by `detect_defs`. Show an info hint so the skip isn't a surprise.

**References**
- `texture` / `texture-faces` must name an existing
  `textures/blocks/<name>.png` in this pack or a dependency. Item `icon` must
  name an existing `atlas:texture` (`blocks:` or `items:`), or a block ID
  when `icon-type: block`.
- `model-name` must name an existing `models/<name>.{vcm,obj,vec3,xml}`.
  Textures used inside custom block models must be `blocks:…` atlas textures
  (`block-properties.md` warning).
- `material` must exist in `block_materials/`. Material sound names must
  resolve to `sounds/<name>(_N).ogg`, following the variant rule from
  `assets-preload.md`.
- `picking-item`, `placing-block`, `parent` and `tags.toml` entries must name
  existing units. Hidden blocks must have `picking-item` (`hidden` docs).
  Remind modders that a block's item is `<id>.item`.
- `ui-layout` (or the implicit block ID) must have a
  `layouts/<name>.xml` when `inventory-size > 0`.
- `script-name`, and the implicit script `scripts/<name>.lua`: warn when a
  script exists but no unit uses it.
- Entities: `components[].name` must map to `scripts/components/<name>.lua`;
  `skeleton-name` must exist (pack prefix is added, so `drop` →
  `base:drop`).
- Skeleton `model` names must exist; bone names must be unique.
- Generators: `structures.toml` names must match a fragment file
  (`fragments/<name>.vox`); biome `block` / `plants` / `structures[].name`
  must resolve; `parameters` length must equal `biome-parameters`; at most
  one filler layer (`height = -1`).
- `preload.json` entries must exist, with an extra hint that layouts and
  models used by skeletons load automatically.

**Value sanity**
- `hitbox` values within `[0, size]`; `emission` within 0..15; total size of
  `fields` ≤ 240 bytes; `state-based.bits` ≤ 4, `variants` ≤ 16;
  `tick-interval` > 0.
- `translucent: true` on a block whose textures have no semi-transparent
  pixels: a performance hint.
- `solid: true` on a non-`custom` model has no effect (doc).
- `content.json` edited by hand: a warning, since it can corrupt worlds.

**Content-pack hygiene**
- Unused textures, sounds and models (tagged `DiagnosticTag.Unnecessary`,
  so they render faded).
- Locale keys used in captions but missing from a language (§3.6).
- `doc/en` / `doc/ru` parity check (a mode for engine contributors, not
  modders).

Every rule has an ID (`VC0001`…), a severity that can be changed with the
`voxelcore.lint.rules` setting, and a quick fix (`CodeActionKind.QuickFix`)
where one makes sense: create the missing file from a template, rename to
the closest known property (Levenshtein distance), or add the declaration to
`user-props.toml`. Whole-pack linting of files that aren't open runs in the
background and reports workspace diagnostics.

### 3.4 VCM / VCA language support — P0

**What the user gets:** highlighting, bracket matching, outline (bones and
primitives), folding, breadcrumbs, completion of primitives and attributes,
validation and hover docs, for `.vcm` (models) and `.vca` (animations).

**How:**
- **Languages** `vcm` and `vca` in `contributes.languages`, with a
  `language-configuration.json` for `#` comments, `{}`/`()` brackets,
  auto-closing quotes and indentation rules.
- **TextMate grammars** (`syntaxes/vcm.tmLanguage.json`,
  `vca.tmLanguage.json`) for highlighting: `@element` names, attribute
  names, strings, `( … )` vector groups with numbers, `$N` texture
  placeholders, `#` comments. VCA adds directive names, `curve` kinds and
  `func ( … )` expressions with operator and function highlighting.
- **Real parser for structure:** `tree-sitter-vcm`, written from the real
  parser (`src/coders/xml.cpp::VcmParser`) and compiled to WASM for
  `web-tree-sitter` in vcls:
  - `element := '@' name attribute* ('{' element* '}')?`
  - `attribute := name value`
  - `value := string('…' | "…") | paren-group '(' … ')' (nested parens) | bare-word`
  - `#` line comments (`hashComment = true`).
  The root may contain several elements. VCA uses the same grammar.
  vcls provides `documentSymbol` (outline/breadcrumbs), `foldingRange`,
  `selectionRange` and **semantic tokens**. Semantic tokens color
  attributes that are invalid for their element differently, which
  TextMate can't do.
- **Semantic validation** in vcls, based on `src/coders/vcm.cpp`:
  - Allowed attributes per primitive: `box`
    (`from`, `to`, `origin`, `rotate`, `texture`, `shading`, `delete`, nested
    `part`), `rect` (`from`, `right`, `up`, `texture`, `region`,
    `region-scale`, `shading`, `flip`, `normal`, `cull-face`), `tri`
    (`a`, `b`, `c`, `uv`, `texture`, `region`, `region-scale`, `shading`,
    `normal`, `cull-face`), `part` (`tags`, `texture`, `region`,
    `region-scale`), `bone` (`name`, `move`, `scale`, `rotate`).
  - Vector arity: `rotate` accepts 3 numbers (Euler) or 4 (quaternion);
    `uv` takes 6; `region` 4; `region-scale` 2.
  - Enumerations: `part.tags` and `box.delete` ⊂
    `{top,bottom,north,south,east,west}`; `cull-face`
    `{front, back, off}`; `flip` `{h, v}`.
  - Texture references resolve against the pack (`blocks:…` for block
    models). `$N` placeholders are valid.
  - Warn when auto-UV primitives are larger than 1.0, since the docs call
    the result undefined.
  - Duplicate named bones; unnamed bones produce an info hint ("dissolved,
    not in skeleton").
  - VCA: allowed directives (`@move`, `@rotate`, `@scale`, `@zoom`,
    `@texture`, `@configure`, `@curve`, `@key`); `by` ∈ `{x,y,z,…}`;
    `curve` ∈ `{const, linear, bezier, .custom}`; bezier keys need
    `lx ly rx ry`; `bone` names must exist in the target skeleton when
    vcls can infer it; `func (…)` expressions are parsed with the documented
    operator and function set, so a typo such as `sinn(t)` gets flagged.
- **Inlay hints** for vectors: `box from (0,0,0) to (1,0.5,1)` shows
  `size 1×0.5×1` after the element.
- Since `vcm::parse` also accepts XML, `models/*.xml` gets the same
  validation through the XML path.
- Formatting (`DocumentFormattingEditProvider` in vcls): a canonical
  pretty-printer (indent nested blocks, normalize `(a, b, c)` spacing).

### 3.5 Cross-reference navigation — P1

vcls maintains a **workspace content index** in `shared/`, updated through
`workspace/didChangeWatchedFiles`:

- Packs found in the workspace. Any folder with `package.json` counts, not
  only folders under `res/content`. Multi-root workspaces are supported.
- The engine's `res/` folder (the `core` pack and the built-in `base`). Its
  location is the `voxelcore.resPath` setting, auto-detected when the
  workspace is the VoxelCore repo or when the `VoxelCore` executable sits
  next to `res/`.
- Units: blocks (+ `.item`), items, entities, skeletons, materials,
  generators, structures, models, textures by atlas, sounds, layouts,
  modules, locale keys and tags.

Features built on the index:
- **Go to definition** (and Ctrl+Click document links) from any string ID
  (`"base:stone"`, `"blocks:grass_top"`, `"steps/stone"`,
  `require "pack:mod"`) to its file. PNG and OGG targets open in VS Code's
  built-in image and audio viewers.
- **Find references** for a block, texture, model or component across JSON,
  TOML, Lua, XML, VCM and VCA.
- **Rename** a unit (`prepareRename` + `rename`): renames the file and
  updates references in one `WorkspaceEdit`, which VS Code previews before
  applying. A warning explains that renaming a unit changes `content.json`
  indices and that existing worlds will request conversion. Renaming a
  texture file in the Explorer triggers the same update via
  `workspace.onWillRenameFiles`.
- **Workspace symbols** (Ctrl+T): "jump to block `wooden_door`".
- **Code lens** above definitions: "3 references · used by 2 scripts".

### 3.6 Locale files — P1

`texts/<lang>.txt` use `key=value` lines with `#` comments
(`res/texts/en_US.txt`), and languages are listed in `res/texts/langs.json`.

- Language `vclang` for `**/texts/*.txt` inside packs, with a TextMate
  grammar and an outline by `# section` (vcls `documentSymbol`).
- Diagnostics: duplicate keys; keys present in `en_US` but missing in other
  shipped languages (a quick fix inserts a stub); unknown language file
  names; captions in definitions with no locale entry. The engine derives
  captions from IDs with `util::id_to_caption`, so the rule checks the
  derived caption key too.
- Hover over a `caption` / locale key in Lua or XML shows all translations.
- Optional: a webview "Translations" table (keys × languages) with inline
  editing, writing back through `WorkspaceEdit`.

### 3.7 XML UI layouts — P1

- A schema for elements and attributes, generated from
  `src/graphics/ui/gui_xml.cpp` (each `add("tag", reader)` registration and
  the `element.attr("…")` / `has("…")` calls) and merged with
  `doc/en/xml-ui-layouts.md`. Some elements, such as `modelviewer`, aren't
  documented yet.
- vcls serves completion, hover and validation for `layouts/**/*.xml`. The
  built-in XML support has no schema awareness, so vcls registers for
  `{language: "xml", pattern: "**/layouts/**/*.xml"}`.
- Typed attribute validation: 2D/3D/4D vectors, `#RRGGBB[AA]` colors (with
  a **color picker** via `DocumentColorProvider`), `gravity` enum,
  `orientation`, `text-align`, `cursor`, `markup`.
- **Lua injection**: the `onclick`, `consumer`, `supplier`, `position-func`
  and `size-func` attributes contain Lua. A TextMate injection grammar
  (`injectionSelector`) highlights them, and vcls resolves function names
  against the sibling `.xml.lua` (go-to-definition, plus "function not
  defined" warnings).
- Element `id`s are offered as completions for `document.<id>` in the
  matching `.xml.lua`.
- `src` / `fallback` on `image` are validated as textures; `src` on
  `modelviewer` is validated as a model.
- P2: a **layout preview** webview that approximates panel/container layout
  (orientation, padding, margin, gravity, sizes) and updates while typing.
  For exact rendering, the engine-accurate preview (§5.2) can load the
  layout.

### 3.8 Snippets, scaffolding and walkthrough — P0

- **Snippets** (`contributes.snippets` for `json`, `lua`, `toml`, `xml`,
  `vcm`, `vca`): block (plain, custom-model, rotatable, extended with
  `size`, inventory block), item, entity with components, skeleton,
  material, particles object, `state-based` variants, block fields, biome,
  generator config; Lua block script, item script, `world.lua`, `hud.lua`,
  component, module skeleton (the `local this = {} … return this` pattern
  from `scripting.md`), layout `.xml` + `.xml.lua`, VCM box or bone, VCA
  keyframe track.
- **Scaffolding commands** (Command Palette, Explorer context menu
  `explorer/context` "New VoxelCore …", and the content explorer view):
  - *New content pack*: a multi-step `QuickPick` / `InputBox` wizard for id
    (validated live with the §3.3 id rule), title and creator. It writes
    `package.json`, an `icon.png` placeholder, the folder layout and
    `.gitignore`, and configures Lua (§3.2).
  - *New block / item / entity / component / generator*: writes all related
    files at once. For example, a new block creates `blocks/x.json`,
    `textures/blocks/x.png` (a placeholder), an optional `scripts/x.lua` and
    `texts/*.txt` entries. Then it opens the JSON.
- **Walkthrough** (`contributes.walkthroughs`): locate the engine →
  create or open a pack → run it in the engine → open a model preview →
  set a breakpoint.

### 3.9 Texture and asset hover previews — P1

VS Code hovers are `MarkdownString`s, which can embed images
(`![](file:///…)` or data URIs; `supportHtml` for sizing).
- Hovering a texture reference (`"grass_side"`, `"blocks:sand"`,
  `"particles:fire_0"`) shows the PNG enlarged with nearest-neighbor
  upscaling (vcls produces a scaled PNG in `context.storageUri`'s cache,
  since 16×16 images are unreadable unscaled), plus its size and alpha
  information.
- Hovering `texture-faces` shows the 6 faces labeled with the engine's face
  order. The order must be taken from `BlockLoader` / `Block.hpp`; the docs
  example suggests east, west, bottom, top, south, north.
- **Gutter decorations**: a tiny texture thumbnail next to each `texture` /
  `texture-faces` line (`TextEditorDecorationType` with `gutterIconPath`).
- Hovering a sound name lists the resolved variant files
  (`name.ogg`, `name_1.ogg`, …) with their durations, plus a "▶ Play" link
  (a command URI that plays the file in a small webview).
- Hovering a `model-name` shows a cached thumbnail rendered offscreen by the
  preview renderer (§5.1), plus an "Open preview" command link.

### 3.10 Content explorer sidebar — P1

A VoxelCore view container in the Activity Bar (`contributes.viewsContainers`)
with tree views (`TreeDataProvider`, fed by the content index):
- **Content**: packs → blocks / items / entities / generators / models /
  textures / sounds, with texture icons as tree item icons, and the unit's
  caption from the locales as the description.
- **Dependencies**: the resolved pack load order, with missing or
  unsatisfied versions marked.
- **Engine**: the configured executable, `res/`, user dir, and connection
  status. Inline actions: Run, Debug, Hot reload, Open log.
- Context menus: open definition, preview, find references, rename, delete
  (with a reference check).

---

## 4. Run, reload, debug, test

### 4.1 Run the pack in the engine — P0

**Problem:** the engine only scans `world:content`, `user:content`,
`project:content` and `res:content` (`ContentControl.cpp`). A pack developed
in its own folder must be copied by hand.

**How:**
- Settings `voxelcore.executable` (auto-detected from `build/*/VoxelCore(.exe)`
  in the engine repo or from `PATH`), `voxelcore.resPath` and
  `voxelcore.userDir` (default: a folder in the extension's workspace
  storage, or `<workspace>/.voxelcore/user` if the user prefers it visible).
- *Prepare dev user dir* (run automatically before launch): creates
  `<userDir>/content/` and **links** every workspace pack into it (a
  symlink on Unix, a directory junction on Windows, which needs no admin
  rights). Edits are then seen live and nothing is copied.
- Alternative without links: the bootstrap script below calls
  `app.set_content_sources({...workspace pack parent dirs, "user:content",
  "res:content"})` (libapp). That needs the folders to be reachable through
  an entry point, so the link approach stays the default.
- A **`TaskProvider`** for task type `voxelcore` (declared in
  `contributes.taskDefinitions`, so users can also customize the tasks in
  `tasks.json`):
  - *VoxelCore: Run* → `VoxelCore --res <res> --dir <userDir>`
  - *VoxelCore: Run with debugger* → adds `--dbg-server tcp:<port>` (§4.4)
  - *VoxelCore: Run headless* → `--headless --script <file>` for automation
  - *VoxelCore: Run quick world*: runs a generated bootstrap script
    (`--script`) that calls `app.reconfig_packs({...workspace packs},{})`,
    `app.new_world(...)` with a chosen generator (picked from a `QuickPick`
    fed by the index) and opens it, so the developer lands in a world with
    the pack enabled in one keystroke. Script APIs: `app.*` from
    `doc/en/scripting/builtins/libapp.md`; the flow mirrors
    `dev/tests/world.lua`.
- A ▶ button in the editor title bar (`menus.editor/title`) when the active
  file belongs to a pack, plus a status bar item "VoxelCore: ▶ Run".

### 4.2 Live hot reload — P1

The engine already supports a lot of this:
- The VC-DBG protocol has a `hot-reload` message (`{"type":"hot-reload",
  "file":"pack:textures/blocks/x.png"}`). It calls
  `AssetsLoader::addReload`, which re-queues every asset loaded from that
  file (`DebuggingServer.cpp:267`).
- Lua has `reload_module(name)` (`res/scripts/stdmin.lua`), tested in
  `dev/tests/reload_module.lua`.

**How:** while the engine runs with `--dbg-server`, the extension keeps a
VC-DBG connection (shared with the debugger, §4.4).
`workspace.onDidSaveTextDocument` handles text files and a
`FileSystemWatcher` handles binary files saved by external editors
(Aseprite, Blockbench, GIMP):
- texture, model, shader, sound or layout file → send `hot-reload` with its
  virtual path (`<packid>:<relative path>`);
- `modules/**/*.lua` → run `reload_module("pack:path")` through the
  debugger or the console bridge (§4.6);
- block/item JSON → a notification "definitions need a content reload",
  with a *Reload content* action that does `app.reset_content()` +
  `app.load_content()` (or `app.reconfig_packs`) from libapp. These must
  run inside the app-script coroutine, and an open world has to be closed
  and reopened.
- A status bar item shows "🔥 hot reload: on" and the last reloaded file.
- An engine-side gap (some asset types aren't registered with
  `attachToFile`, or definitions can't be reloaded in place) is recorded in
  an "engine upstream wishlist" (§7), not worked around in the extension.

### 4.3 Engine log → Problems panel + Output channel — P1

- A **"VoxelCore" Output channel** (a `LogOutputChannel` with levels)
  shows the stdout of engines launched by the extension, and tails
  `<userDir>/latest.log` for engines started outside VS Code. Logger lines
  look like `[level] module: message`.
- A **problem matcher** `$voxelcore` (in `contributes.problemMatchers`) for
  task output. vcls also does richer parsing and maps known patterns to
  file diagnostics: Lua errors with `pack:scripts/x.lua:42:` tracebacks,
  `file "…": …` loader errors (`ContentUnitLoader::loadUnit` wraps them
  with the file path), `unknown model:` / `unknown rotation profile` /
  `unknown culling mode` errors from `BlockLoader.cpp`,
  `Failed to find parent(…)`, and `unknown resource type`.
- Virtual paths (`base:scripts/x.lua`) are translated back to workspace
  files through the content index. A `DocumentLinkProvider` makes them
  clickable in the Output channel.
- These "runtime" diagnostics use a separate `DiagnosticCollection`
  (`voxelcore-runtime`) and are cleared on the next run.

### 4.4 Lua debugger — P1

The engine implements **VC-DBG v1.1** (`doc/specs/debugging_protocol.md`;
`src/devtools/DebuggingServer.cpp`; Lua side
`res/modules/internal/debugging.lua`). It works like this:
- an 8-byte handshake `"vc-dbg\0" + version`;
- messages framed with a uint32-LE length, carrying JSON;
- commands: `connect` (with `disconnect-action`), `set-breakpoint` /
  `remove-breakpoint` (`source` = virtual path, `line`), `step`,
  `step-into-function`, `resume`, `pause`, `terminate`, `detach`,
  `get-value` (`frame`, `local`, `path`);
- events: `paused` (reason `breakpoint|exception|step`, stack frames with
  locals), `value`, `success`, `resumed`.

**How:** debug type `voxelcore` in `contributes.debuggers` (with
`configurationAttributes` for launch/attach, `initialConfigurations` and
`configurationSnippets`, and `breakpoints: [{language: "lua"}]`).
A `DebugAdapterDescriptorFactory` returns a
**`DebugAdapterInlineImplementation`**: the adapter (based on
`@vscode/debugadapter`'s `LoggingDebugSession`) runs inside the extension
host and talks to the engine over a Node `net.Socket`. There's no separate
process or binary.

| DAP | VC-DBG |
|---|---|
| `launch` | run the §4.1 "Prepare dev user dir" step, start `VoxelCore --dbg-server tcp:<free port> …` (the same args as §4.1), then connect |
| `attach` | connect to an existing port (e.g. an instance started by `app.start_debug_instance`) |
| `setBreakpoints` (file path) | map the workspace path to the virtual `pack:path` via the content index; send remove + set for diffs |
| `continue` / `next` / `stepIn` | `resume` / `step` / `step-into-function` |
| `pause` / `terminate` / `disconnect` | `pause` / `terminate` / `detach` |
| `stopped` event | from `paused` (reason mapped; `message` → exception text) |
| `stackTrace` / `scopes` / `variables` | from the `paused.stack[].locals`; expanding a table → `get-value` with a path |

Notes:
- Variable references encode `(frame, local, path)`.
- No `evaluate` yet. Simple dotted paths in hovers and the Watch panel can
  be emulated with `get-value`; full evaluation is an upstream wishlist
  item.
- The engine's output goes to the Debug Console through DAP `output`
  events, and Lua tracebacks in it are clickable.
- The engine is single-threaded for Lua, so the DAP thread is just one
  thread (id 1, "main").
- Hot reload (§4.2) reuses the debug session's socket when one is active.

### 4.5 Pack test explorer — P2

- Packs can ship `tests/*.lua` that run under
  `VoxelCore --headless --test <file> --res <res> --dir <tmp>`, the same way
  `vctest` runs `dev/tests/*.lua`. The `test` library (`libtest.cpp`,
  `res/modules/internal/test.lua`) is available in this mode.
- A **`TestController`** discovers test files, and named sections when a
  convention is adopted, then shows them in the Testing view. It has run
  and debug profiles: debug adds `--dbg-server` and attaches §4.4
  automatically.
- Exit code and `print` output go into `TestRun.appendOutput`. Failures
  with `file:line` become `TestMessage`s with locations, so they show
  inline in the editor.
- ▶ gutter icons appear automatically through the Testing API.

### 4.6 Console / command bridge — P2

- `--stdin-cmd` makes the engine execute each stdin line as a console
  command (`src/devtools/stdin_cmd_reader.cpp`). The console commands are
  defined in `res/scripts/stdcmd.lua`.
- When the extension launches the engine itself (as a child process, not a
  shell task), it keeps stdin open and exposes:
  - *VoxelCore: Run console command…*: a `QuickPick` with commands and
    arguments parsed from `stdcmd.lua`
    (`console.add_command(scheme, description, fn)`), so completion matches
    the real console;
  - a **Pseudoterminal** "VoxelCore Console" that works like the in-game
    console, with history;
  - code actions such as "Give me this item" on an item definition,
    "Teleport to …", "Set time", and "Reload module" (§4.2).

---

## 5. Visual tools (webviews inside VS Code)

All previews are webview panels opened **beside** the source
(`ViewColumn.Beside`), like the built-in Markdown preview. They're opened
from an editor title button (`$(preview)`), a code lens "▶ Preview" above a
model or block, the content explorer, or *VoxelCore: Open Preview*. One
bundled app (`webview/`, three.js + a small UI layer) renders all preview
kinds; the extension tells it what to show.

Shared mechanics:
- **Live updates without saving**: the controller listens to
  `workspace.onDidChangeTextDocument` and posts the new text to the
  webview, so the preview changes on every keystroke. The shared VCM mesh
  builder (§1) produces the mesh.
- **Two-way selection sync**: `window.onDidChangeTextEditorSelection` →
  highlight the primitive, bone or keyframe under the cursor. Clicking an
  object in the preview → `postMessage` back → the extension reveals and
  selects its source range.
- **Assets**: textures load through `webview.asWebviewUri`, with
  `localResourceRoots` limited to workspace packs + engine `res/`. Asset
  file watchers trigger re-texturing.
- **Theme**: the preview reads VS Code theme CSS variables for its UI
  chrome. The 3D background is configurable.
- **Persistence**: camera and toggles are saved with `setState`, and a
  `WebviewPanelSerializer` restores open previews after a reload.
- **Security**: strict CSP (`default-src 'none'`; scripts with a nonce;
  `img-src` limited to `webview.cspSource`).

### 5.1 Model preview — P0

**What the user gets:** a 3D view of `.vcm`, `.obj` and `.vec3` models next
to the text. Features: orbit/pan/zoom, a 1×1×1 block grid and axes,
wireframe, normals, culling and shading toggles, per-primitive highlight
(the cursor in the `.vcm` selects the primitive), an atlas texture overlay,
and a bone list with visibility toggles.

**How:**
- `.vcm`, `.vca` and `.xml` models are text and keep the normal text editor;
  the preview is a side panel.
- `.obj` uses a side panel too.
- **`.vec3` is binary**, so it gets a `CustomReadonlyEditorProvider`
  (`contributes.customEditors`, `priority: "default"`). Double-clicking a
  `.vec3` file opens the 3D view directly, with a header showing what the
  file contains (from `doc/specs/vec3_model_spec.md`).
- **Loaders** reimplemented in `shared/` from the engine sources so the
  result matches:
  - VCM/XML: port `vcm.cpp` (box → 6 rects with `part` overrides, `delete`,
    `origin`/`rotate` with Euler or quaternion, auto-UV from size, `region`,
    `region-scale`, `flip`, `cull-face`, bone transforms
    `scale → rotate → move`).
  - OBJ: `src/coders/obj.cpp` semantics (`.mtl` ignored; material name =
    texture name).
  - vec3: `doc/specs/vec3_model_spec.md` + `src/coders/vec3.cpp`.
- **Textures** resolve through the same rules as the engine: atlas prefixes
  (`blocks:`, `items:`, `entities/x:`), pack search order and `$N`
  placeholders (shown as colored debug textures). PNGs load bottom-up like
  `png.cpp`, so UV orientation matches. This is the exact pitfall documented
  in the backrooms README. Textures use `NearestFilter`.
- **Golden tests**: the shared mesh builder's output is compared against
  the engine's `assets.parse_model` (`libassets.md`) run headless on every
  model in `res/` and `res/content/base`, so the port can't drift
  unnoticed.
- **Thumbnails** for hovers and the content explorer (§3.9, §3.10): a
  hidden webview renders offscreen and posts back a PNG data URL, which is
  cached in `context.globalStorageUri`. No native renderer is needed.

### 5.2 Engine-accurate preview (real renderer) — P1

The webview is fast but is a re-implementation. For pixel-exact results
(lighting, AO, shaders, `draw-group`, translucency, emission), the extension
can also run **the engine itself** as the previewer:

- `preview-project/` is a VoxelCore project (`project.toml` +
  `project_client.lua`, see `res/project/`) with the `debugging` permission.
  On startup it reads `__VC_PROJECT_ARGS` (`--model <name>`, `--block <id>`).
- Its menu screen hosts a layout containing a **`modelviewer`** element,
  which already exists in the engine (`src/graphics/ui/elements/ModelViewer`,
  XML reader `read_model_viewer`: `src`, `center`, `cam-rotation`). That's
  enough for model preview without creating a world.
- For a block in its real environment (lighting, neighbors), the project
  opens a tiny flat world (`core:default`/`base:flat_grass` generator), places
  the block in a showcase pattern (all rotations of the profile, every
  `state-based` variant, a light test next to stone) and fixes the camera.
- Live updates use the engine's own `hot-reload` debug message (§4.2).
- Launched with
  `VoxelCore --project <ext>/preview-project --res <res> --dir <userDir> --dbg-server tcp:<port> -- --model foo`.
  It opens in its own engine window; the webview preview shows an "Open in
  engine" button.

### 5.3 Skeleton and animation preview — P1

- Skeleton JSON (`root`, `nodes`, `name`, `model`, `offset`) or VCM `@bone`
  hierarchies are drawn as a bone tree with the attached models. The bone
  tree is also listed in the webview's side panel.
- **VCA playback**: a timeline (`configure fps/frames/duration`), play/pause,
  scrubbing, loop, and per-track curves with keyframes for
  `const|linear|bezier|custom` and `func (...)` expressions. The expression
  evaluator implements the documented operators and functions (`sin`, `cos`,
  `noise`, `noise2d`, `rand`, `min`, `max`, …). The reference implementation
  is `res/modules/internal/animation_codegen.lua`. For bit-exact behavior
  the preview can run it in **Fengari or wasmoon** (Lua in the browser).
  Their semantics differ slightly from LuaJIT, so golden tests against the
  headless engine cover the curve output.
- The animation's target skeleton is chosen from a picker (entities that
  use it are listed) and remembered per `.vca` file in workspace state.
- The cursor on a `@key` line highlights that keyframe and moves the
  playhead.
- P2: dragging a key in the curve editor writes back to the file via
  `WorkspaceEdit`, so it gets normal undo/redo.

### 5.4 Block preview — P1

Opened from a block JSON (title button / code lens):
- The cube with `texture` / `texture-faces` applied and each face labeled
  (fixes guessing the face order), or the `X` model, `aabb` from the
  hitbox, or a `custom` model from `model-name`.
- **Hitboxes** (`hitbox` / `hitboxes`) as wireframes, plus `size` for
  extended blocks.
- **Rotation profiles**: a toggle to cycle all orientations of `pipe`,
  `pane`, `stairs`, `ladder`.
- **State-based variants**: a slider over variant indices.
- `emission` color swatch, `translucent`, `shadeless`, `ambient-occlusion`
  approximations, and an "Open in engine" button (§5.2).
- Editing the JSON updates the preview immediately, like §5.1.

### 5.5 Multi-block texture helper — P2

The backrooms pack splits one 48×48 image into 9 hidden helper blocks by
hand (`carpet`, `carpet_1`…`carpet_8`, picked by `x mod 3 + 3·(z mod 3)`).
- A command on a PNG (Explorer context menu): *"Split into N×M block
  tiles"*. It slices the PNG in the extension host (`pngjs`, respecting the
  bottom-up row order), writes `textures/blocks/<n>_k.png`, generates hidden
  helper blocks with `picking-item` pointing at the main block, and adds an
  optional Lua placement helper. Everything goes in one `WorkspaceEdit`, so
  it can be undone.
- A webview "tile view" shows a texture repeated 3×3 to check seams, and
  watches the file while it's edited in an external image editor.

### 5.6 Particle preset preview — P2

The `particles` object from a block or a preset is simulated in the webview
with the fields from `particles.md` (spawn shapes, spread, velocity,
acceleration, lifetime, frames, angular velocity). It re-runs while the JSON
is edited. The accurate path uses the engine preview project, which calls
`gfx.particles.emit`.

### 5.7 World-generator preview — P2

- Runs the generator script **headless** (`--headless --script`), in a
  small harness script that calls `generation.*` / heightmap functions for
  an area. It uses `Heightmap:dump("export:…png")` (documented in
  `world-generator.md`) to write height and biome-parameter maps, plus a
  top-down biome color map.
- A webview shows the maps side by side with seed and area controls, and
  can zoom and pan. It re-runs (debounced) on save of `script.lua` /
  `biomes.toml`. A `CancellationToken` kills a stale engine process.
- A biome-overlap warning flags parameter/weight setups that cause the
  "depth conflict" effect described in the docs.

---

## 6. Other features

| Feature | Pri | How |
|---|---|---|
| **Formatter** for JSON definitions (stable key order: visuals → lighting → physics → inventory → other, following doc section order) and VCM | P2 | vcls `textDocument/formatting`; opt-in via `voxelcore.format.sortKeys` |
| **Pack packaging**: build a `.zip` of the pack without dev files; validate first | P1 | command + task (`yazl`); a `.vcpackignore` file |
| **Dependency graph**: check `!`/`?`/`~` deps and version ranges against packs found in all content sources; detect cycles | P1 | vcls, mirrors `PacksManager::assemble`; shown in the Dependencies tree view (§3.10) |
| **Docs lookup**: "Open docs for this property/function" opens the matching `doc/en` (or `doc/ru`, per setting) section | P1 | code action → the built-in Markdown preview, or the GitHub URL when the engine repo isn't local |
| **Engine-version awareness**: schemas/meta are per engine version; read the target from `package.json` (future `engine` field) or the `voxelcore.engineVersion` setting | P1 | the extension bundles several schema sets |
| **Content-index change warnings**: adding or removing units changes `content.json` → worlds will ask to convert; renaming block `fields` triggers a block-layout conversion | P2 | info diagnostics on save |
| **AI assistant integration**: Language Model Tools (`contributes.languageModelTools`, `vscode.lm.registerTool`) answer "what properties does a block have", "list my pack's blocks", "show the generator API" from the same index and schemas. Optionally an MCP server (`vcls --mcp`) for other clients | P2 | client + vcls |
| **File icons** for `.vcm`, `.vca`, pack `package.json` | P2 | `icon` in `contributes.languages` (no icon theme needed) |
| **Fragment (`.vox`) inspector**: show size, block palette and entities of generator fragments (`doc/specs/fragment_file_spec.md`) | P2 | `CustomReadonlyEditorProvider` + 3D webview |
| **Sound preview**: play `.ogg` variants and see material sound sets | P2 | webview (`<audio>`), material hover links |
| **Settings sync for teams**: recommend the extension in `.vscode/extensions.json` when the scaffolder creates a pack | P2 | scaffolder |

---

## 7. Engine-side wishlist (upstream PRs, not part of the extension)

Things the extension would like from the engine. Each is small and can be
proposed upstream:
1. **Warn about unknown properties** instead of dropping them in
   `post_content.lua`. This removes the need for the most important lint
   rule at runtime.
2. A **machine-readable API dump**: a `--dump-api` flag that writes every
   library function and its `luaL_Reg` entries to JSON. This would make §3.2
   exact instead of parsed from markdown.
3. An **`evaluate`** command in VC-DBG, plus breakpoint confirmation
   (verified lines).
4. A **content-reload** command in VC-DBG (reload definitions without
   restarting).
5. **Structured logs**: a `--log-format json` option for §4.3.
6. **Extra content sources** from the command line (`--content <dir>`), so
   §4.1 doesn't need links or a bootstrap script. Lua already has
   `app.set_content_sources`.
7. Document `modelviewer`, `parent`, `overlay-texture`,
   `surface-replacement` and the `*-interpolation` generator keys in
   `doc/en` and `doc/ru`.

---

## 8. Implementation order (proposed)

1. **Phase 1 — skeleton + data** (P0 foundation):
   `package.json` manifest, `src/extension.ts`, `tools/gen-schemas` +
   `jsonValidation` (useful on day one), `tools/gen-lua-meta` + Lua
   configuration, TextMate grammars for VCM/VCA, and a minimal `vcls`.
2. **Phase 2 — model preview**: the shared VCM/OBJ/vec3 mesh builder,
   the webview preview with live updates and selection sync, and golden
   tests against `assets.parse_model`. This comes early because the webview
   is the main reason for choosing VS Code.
3. **Phase 3 — linter + navigation**: content index, `tree-sitter-vcm`
   (WASM) in vcls, the lint rules from §3.3, go-to-definition and
   references, snippets and scaffolding, texture hovers, content explorer.
4. **Phase 4 — run loop**: user-dir linking, TaskProvider, Output channel
   and log diagnostics.
5. **Phase 5 — debugger + hot reload**: inline DAP over VC-DBG,
   hot-reload on save.
6. **Phase 6 — the rest**: block and animation previews, XML layouts,
   locales, the test explorer, engine-accurate preview project, generator
   preview, LM tools, packaging.

Tooling: TypeScript, esbuild bundles (extension, server, webview),
`@vscode/test-electron` for integration tests, `@vscode/vsce` and `ovsx` to
publish to both the VS Code Marketplace and Open VSX (VSCodium, Cursor,
Windsurf).

## 9. Open questions

- Should `shared/` + `server/` + `grammars/` move to an editor-independent
  location (for example `editor-tooling/`) so `zed-extension/` can reuse
  them?
- Make *Even Better TOML* and *sumneko.lua* hard dependencies
  (`extensionDependencies`, auto-installed) or recommendations? Hard
  dependencies make the experience consistent; recommendations are less
  intrusive.
- How to locate the engine `res/` for modders who use a release build
  instead of the repo: a setting, a `VOXELCORE_HOME` environment variable,
  or detection from the executable.
- Webview renderer: plain three.js, or a small custom WebGL2 renderer that
  mirrors the engine's `main.glslv/.glslf` shading more closely?
- Should the extension also work in the browser (vscode.dev) for
  schema/lint-only use? That's a web extension build with no engine
  launch.
