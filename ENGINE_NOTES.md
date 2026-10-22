# Engine findings (candidates for upstream issues)

Found while building the extension by reading the engine sources (v0.32).
The extension mirrors the engine's actual behaviour and flags these where
useful. File/line references are to the VoxelCore repo.

## Docs vs code

- **Generator `biomes-bpd`**: documented in `world-generator.md`, but
  `GeneratorLoader.cpp` reads `biome-bpd`. The documented key is silently
  ignored.
- **Particle defaults**: `max_distance` is 32 in code, 16 in the docs;
  `spawn_interval` is 0.1 in code, 1.0 in the docs.
- **Entity `save-body-settings`**: defaults to true in code, false in the docs.
- **`resources.md`** says `post-effect`; the key is `post-effect-slot`.
- **`state-based.bits`**: the docs say 4 is the practical maximum; the code
  accepts up to 8. At most 15 variants fit besides the root.
- **VCA expressions** (`res/modules/internal/animation_codegen.lua`):
  - `e` is documented but overwritten with `math.e`, which is nil.
  - `rand` is documented but not exported.
  - The docs say `noise2d`; the code exports `noise2`, which doesn't exist
    in `math`, so neither works.
  - `abs` works but isn't documented; `-` is missing from the operator list.
  - The `"end"` check is a substring match, so identifiers like `blend` are
    rejected.
- **VCA `by`**: matched with `("xyz"):find(by)`, so `by xy` silently means x.
- **`on_player_tick`**: documented under block events, but only `world.lua`
  registers it.
- **Undocumented callbacks**: `on_breaking`, `on_block_breaking`,
  `on_progress` / `on_destroy` (layouts), `on_enable` / `on_disable`
  (components).
- **Undocumented keys**:
  - Blocks: `parent`, `caption`, `overlay-texture`, `surface-replacement`.
  - Generators: `heights-interpolation`, `biomes-interpolation`.
  - Particles: `global_up_vector`.
  - All block-material keys.
  - `project.toml`.
  - Preload: the `atlases` and `post-effects` categories and their options.
  - The `modelviewer` UI element.
- **VCM `uv (0,0,1,0,1)`** (the doc example): `Attribute::asNumbers` wraps
  around, so a short list repeats values instead of erroring.
- `block-properties.md` ends with an unclosed code fence.

## Behaviour worth a look

- Unknown block/item properties are dropped silently by `post_content.lua`.
  A warning would remove a whole class of modder mistakes.
- `blocks/<sub>/x.json` gets the id `<sub>:x`, which overrides pack `<sub>`'s
  unit instead of creating `pack:sub/x`. Deeper nesting produces ids whose
  file the loader never finds.
- OBJ loader:
  - Faces before the first `usemtl` are dropped, so a file without
    `usemtl` loads empty.
  - Negative indices loop forever.
  - Trailing blank lines throw "unexpected end".
- VCM:
  - `@tri` normals aren't transformed by bone or box matrices (rect normals
    are).
  - Named bones inside an unnamed `@bone move` get the translation twice.
- `assets.parse_model` is unavailable headless, and no Lua API exposes mesh
  data. That's why the preview's golden test links `VoxelCoreSrc` directly
  (`test/preview/dumper`).
- Item `description`, `uses`, `uses-display`, `model-name` and `emission` are
  missing from Lua `item.properties` (the `post_content.lua` name list).
- `WeatherPreset::intensity` is never read from preset files.
- `Player::attemptToChooseSpawnpoint` truncates float coordinates toward
  zero, so it checks one column but spawns the player in the neighbouring
  one on negative coordinates (found while building `packs/backrooms`).

### Found while building the block / entity preview (§5.4, §5.8)

- **Inherited state-based variants override the child's root.**
  `Block::cloneTo` copies the parent's `variants`, the child's
  `load_variant(def.defaults, ...)` then changes only `defaults`, and
  `ContentBuilder::build` sets `def.defaults = variants[0]` (the parent's
  root). A child of a block with `state-based` silently loses its own
  `texture` / `texture-faces` / `model` / `model-name` unless it redefines
  `state-based`. The preview reproduces this and warns.
- **`size` + `state-based`**: `BlockLoader` turns a `block` model into
  `aabb` for extended blocks *after* the variants were copied from
  `defaults`, and `ContentBuilder` then restores `defaults` from
  `variants[0]`, so the conversion is lost (model `block`, hitbox = size).
- **`AABB::transform`** (`src/maths/aabb.hpp`) adds corner `(b.x, b.y, b.z)`
  twice and never `(a.x, b.y, b.z)`. Rotated `aabb` entity sensors can get a
  too-small bounding box when the rotation isn't only around Y.
- **Entity sensor indices**: `EntityLoader` numbers a child's sensors from 0
  and appends them to the parent's, so `on_sensor_enter` receives the same
  index for a parent's and a child's sensor.
- **Custom block models**:
  - `ModelsGenerator::prepareModel` indexes `textureFaces[index]` (a
    `std::array`) with the number after `$` unchecked (`$6` is UB), and
    `std::stoll` on `$x` throws an uncaught `invalid_argument`.
  - Any atlas prefix is accepted: `ContentGfxCache` strips it and looks the
    name up in the `blocks` atlas (`entities:foo` uses `blocks/foo`). A
    texture without `:` keeps raw UVs over the whole atlas.
  - A `model-name` pointing to a VCM with `@bone`s fails: the loader stores
    only `<name>.<part>` models and a skeleton, so
    `assets.require<model::Model>(name)` throws (unless `preload.json`
    sets `squash`). vec3 sub-models aren't squashed either, so their
    `origin` is ignored for blocks and skeleton bones.
- **`texture-faces` docs** (`block-properties.md`) don't give the face
  order. It's `-X, +X, -Y, +Y, -Z, +Z` (`FACE_MX..FACE_PZ`,
  `BlocksRenderer::blockCube`); `ModelsGenerator.cpp` names them west, east,
  bottom, top, south, north while VCM `SIDE_INDICES` call -Z north. The doc
  also says `texture-faces` "can't be used" with `texture`; the code just
  ignores it.
- **`aabb` model UVs** aren't cut to the box: every face shows the whole
  texture squashed (`BlocksRenderer::blockAABB`), and its bottom face uses a
  different basis than the cube's (rotated 180°).

### Found while building log → Problems and the content explorer (§4.3, §3.10)

Checked against real headless runs (`test/log/fixtures/logs/`).

- **Parse error positions**: `parsing_error::errorLog` (`src/coders/commons.cpp`)
  prints `line + 1`, but `BasicParser::line` already starts at 1, so the
  reported line is one too far. The column is 0-based. The extension
  corrects both.
- **`error()` locations**: `error` is wrapped by
  `res/modules/internal/debugging.lua:149`, which doesn't pass the level on.
  Every `error("…")` message is reported as
  `[string "core:modules/internal/debugging.lua"]:149: …` instead of the
  caller's line. Only the traceback has the real location.
- **Block enum errors have no context**: `unknown model: …`,
  `unknown culling mode: …`, `unknown rotation profile …` and
  `unknown grounding behaviour: …` (`BlockLoader.cpp`) don't name the block
  or file (the item errors do). The extension finds the file by searching the
  pack named by the preceding `loading pack [id]` line.
- **`Unresolved blocks dependencies detected.`** (`ContentLoader.cpp`) names
  neither the unit nor the missing parent. A single unloadable unit (bad
  JSON, type error, missing parent, missing component, block-script syntax
  error) aborts loading the whole content, so the world doesn't open.
- **Headless app scripts that fail don't exit**: when a `--script` app
  script throws (e.g. `app.new_world` fails on content errors), the error is
  logged and the engine keeps running headless until killed. Observed
  too: `app.new_world` with the name of an existing world hung without
  logging anything.
- **Weak dependencies don't order packs**: `resolve_dependencies` skips
  `~weak` dependencies from the second pass on, so with `w` depending
  `~a` (both enabled), the order is `w` before `a` whenever `a` has
  unresolved dependencies of its own in the first pass. The docs only say
  "weak dependency".

### Found while building the debugger and hot reload (§4.4, §4.2)

Checked against real engine runs over VC-DBG (`test/debug/`, headless; the
asset paths also with a client run).

- **`step` works once**: in `res/modules/internal/debugging.lua` the line
  hook declares `local func` inside `if not dbg_step_into_func then … end`,
  then sets `current_func = func` after the block, i.e. the global `func`
  (nil). After the first step every `step` compares against nil and runs
  until the next breakpoint. Fix: declare `func` before the `if`. The
  adapter builds next / step out from `step-into-function` + stack depth
  instead.
- **`get-value` resumes after a step or `error()` pause**: only the
  breakpoint path loops (`while debug.pull_events() do __pause() end`). The
  step path calls `debug.pull_events()` once and returns, so a value
  request runs the next line; the `error()` pause returns and raises.
  Fix: use the same loop in both places. The adapter expands tables only at
  breakpoint pauses.
- **`pause` isn't implemented**: `DebuggingServer::performCommand` has no
  `pause` branch ("unsupported command 'pause'"), though the spec lists it.
  `step-into-function` sent while running pauses at the next Lua line, but
  first inside `debugging.lua` itself (`pull_events`, line 125).
- **A step onto a line with a breakpoint pauses twice**: the hook pauses for
  the step, then checks breakpoints and pauses again (`breakpoint`) at the
  same line.
- **`error()` always pauses while a client is connected**: there's no
  exception filter in the protocol. Clients that only want hot reload must
  answer every `paused` with `resume`.
- **No wait for the client**: `--dbg-server` doesn't block until a client
  connects, so breakpoints in content scripts and `on_world_open` are
  missed unless the app script waits (the extension's quick-world script
  waits for a file the debugger writes).
- **The spec's `locals` is a list**, not the object shown in
  `debugging_protocol.md`: `[{name, index, type, short}]`.
- **One message per frame**: `ClientConnection::read` returns after
  reading the 4-byte length; the body is read on the next `update()`. Each
  message costs about two frames.
- **Hot reload paths**: `hot-reload` needs the path the asset was loaded
  from (`user:content/<pack>/textures/gui/x.png`), not
  `<pack>:textures/…` (that enqueues 0). Only standalone textures, models,
  VCA animations and post effects call `attachToFile`; atlas textures
  (`blocks`, `items`, `particles`), shaders, sounds and layouts can't be
  reloaded.
- **App scripts can't write to `user:`**: only `world:`, `export:` and
  `config:` are writeable (`EnginePaths::isWriteable`), so the dev bridge
  lives in `<userDir>/export/vscode/`.

### Found while building asset hovers and locale checks (§3.9, §3.6)

- **A broken locale file stops content loading**: `texts/<lang>.txt` is
  parsed by `BasicParser` (`src/frontend/locale.cpp`) on every content load
  (`Engine::onContentLoad`). A line without `=` or an unknown `\` escape
  throws. With that language or the fallback (`en_US`) selected,
  `app.new_world` fails with `non-closed string literal` (checked
  headless), and the message names neither the pack nor the file. Other
  languages' files aren't read, so their errors stay hidden until a player
  picks that language.
- **`base` has an untranslated block**: `base:coal_ore` (caption
  `coal ore`) has no entry in any of base's `texts/*.txt` (fi_FI, ru_RU,
  uk_UA, uz_UZ), while every other base block does.
- **`base` ships no `en_US.txt`**: English captions are the ids
  themselves (`util::id_to_caption`; `langs::get` returns the key when it
  isn't found). So missing-translation checks compare a pack's non-fallback
  languages with each other, not with `en_US`.

### Found while extracting the XML layout elements (§3.7)

From `src/graphics/ui/gui_xml.cpp`, compared with `doc/en/xml-ui-layouts.md`
(`node tools/gen-layouts.mjs` prints these as warnings):

- **Undocumented elements**: `modelviewer` (`src` model, `center` and
  `cam-rotation` vec3) and `pagebox`. The engine's own `code_editor.xml`
  and `settings.xml` use them.
- **Undocumented attributes read for every element**: `context` (the
  locale context for `@key` texts; template attribute), `hover-color`,
  `pressed-color`, `enabled` and `align` (left/center/right/top/bottom).
  Also `font` on `select`, `focused-color` on `textbox`, `value` on
  `option`, and `item-source` on `slots-grid` (documented only for `slot`).
- **`interval` is listed under "Common panel attributes"**, but only
  `<panel>` reads it (`read_panel`). `button`, `checkbox`, `select` and
  `bindbox` (also panels) ignore it, and so does `container`. The engine's
  own `res/layouts/pages/content.xml` and `content_menu.xml` set
  `interval='5'` on their root `container`, which has no effect.
- **`trackbar` `track-width`**: the docs say the default is 1; the engine
  default is 12.
- **Colours accept more than the docs say**: `Attribute::asColor`
  (`src/coders/xml.cpp`) also takes `r,g,b,a` numbers in 0–255; the docs
  say "only HEX notation". A wrong-length hex colour throws.
- **Vectors broadcast one number**: `asVec2/3/4` turn `"10"` into
  `10,10(,10,10)`, but two numbers for a vec3/vec4 throw `invalid vec4
  value`. `asBool` is true only for `true` and `1`, so `yes` or `True` is
  silently false.
- **`slot` `onrightclick` is read twice** (from the source, not run): once
  as the slot's callback (an expression called with the inventory id and
  slot index, `read_slot_func`), and again by `read_uinode` as a Lua
  *chunk* for the slot's own click action. A function name such as
  `onrightclick="on_rmb"` isn't a valid chunk, so the second read should
  log a syntax error for every such slot when the layout loads.
- **Backslashes in layout text are escapes** (checked headless with
  `xml.parse`): attribute values and inner text go through
  `BasicParser::parseString`, so `\n` is a newline and a Windows path such
  as `C:\q` fails the whole layout with `'\q' is an illegal escape`. For
  inner text, the error position is relative to the text, not the file
  (`[string]` at `2:3`).
- **A newline inside a quoted attribute value fails the layout**
  (`non-closed string literal`), so multi-line `onclick` code isn't possible.
- **`< panel>` at the very start of a file parses as text** (checked
  headless): the declaration check calls `peek()` (which skips whitespace),
  sees no `?` and goes back one character, landing on the space. The root
  becomes the text `panel >`, and loading fails with `unsupported element
  '#'`. Elsewhere `< panel>` and `</panel >` are accepted.
- **Numbers are read from a prefix**: `util::parse_double` uses
  `std::from_chars` and ignores what follows the number, so `size="100 50"`
  is `100,100`, `interval="2px"` is 2 and `padding="1,2,3,4,5"` drops the
  5, all silently. Integers (`std::stoll`) do the same: `z-index="1.5"` is 1.
  Only text without a leading number throws (`invalid number format`).
- **A non-numeric integer may escape the asset loader** (from the source,
  not run): `std::stoll` throws `std::invalid_argument`, a `logic_error`,
  but `AssetsLoader::loadNext` catches only `parsing_error` and
  `std::runtime_error`. `z-index="top"` in a pack's top-level layout would
  then propagate past the loader instead of being reported as a failed
  asset.
- **The root element's id is replaced**: `UiDocument::read` calls
  `setId("root")` on the root, so `<splitbox id="editorRoot">` in
  `res/layouts/code_editor.xml` is only reachable as `document.root`.
- **Duplicate ids hide whole subtrees**: `UINode::getIndices` returns early
  when an id is already taken by an attached element, without indexing the
  duplicate's children, so `document.<id>` is nil for every element inside
  it. `res/layouts/pages/content.xml` has three elements with id
  `move_left` (lines 6, 10, 30: a check mark, a cross and the left arrow),
  apparently copy-paste; its script doesn't use `document.move_left`, so
  nothing breaks today.
- **A missing image texture draws a plain rectangle**: `Image` passes a null
  texture to `Batch2D::texture`, which binds the blank texture, so the
  element is a solid rectangle of its colour instead of nothing.
  `res/layouts/templates/binding.xml` uses `gui/left_half_block`, which
  doesn't exist (only `gui/half_block.png`, preloaded): the conflict marks
  that `settings_controls.xml.lua` shows next to bindings are therefore
  coloured bars, not half blocks.
- **Unknown attributes are dropped silently**: readers only look up the
  attributes they know, so a typo such as `orientaton` has no effect and
  produces no message. Unknown *elements* do fail (`unsupported element`).

### Found while adding project support (§3.11)

Checked with a windowed and a headless engine run (`--project <dir>`) unless
marked otherwise.

- **Projects are barely documented**: `doc/en` only mentions the
  `project:content` source (`content-packs.md`). `project.toml` keys
  (`name`, `title`, `base_packs`, `permissions`), the permissions, `start.lua`,
  `project_client.lua` and its `on_<screen>_setup` / `on_<screen>_clear`
  callbacks are only in the source (`Project.cpp`, `AppScriptsControl.cpp`,
  `scripting.cpp` `LuaProjectScript`).
- **A bare `require` fails in `project_client.lua`**: the script is loaded
  with the chunk name `script.name()` (`project_client.lua`, no entry point),
  so `require "x"` throws `invalid path syntax (':' missing)` from
  `parse_path`; `require "project:x"` works. In `start.lua` (chunk
  `project:start.lua`) a bare `require "x"` loads `<project>/modules/x.lua`.
  Errors in the client script are logged as `[string "project_client.lua"]:N`.
- **Headless, a project's `start.lua` stops at its first wait**:
  `AppScriptsControl` starts `project:start.lua` when there's no `--script`,
  but `ServerMainloop::run` returns at once ("nothing to do") when
  `scriptFile` is empty, so the coroutine never resumes after its first
  `app.tick()` / `app.sleep()`. A headless project has to be run with its
  script as `--script`.
- **Unknown permissions are accepted silently** (only logged in the
  `permissions:` list), so a typo like `netwrk` simply leaves the permission
  off; `network.*` then throws "network subsystem is not available in the
  project".
- **`file.mkdir` / `file.mkdirs` skip the write check**: unlike
  `file.write`, `write_bytes`, `remove` and `remove_tree`, they don't call
  `is_writeable`, so without `write-to-user` `file.write("user:x")` is
  "access denied" but `file.mkdir("user:dir")` creates the folder.
- **`app` isn't a global in client pack scripts** (from the source, not
  run): `lua_engine.cpp` sets the `app` global only for `StateType::SCRIPT`,
  which is the main state when headless; a client's main state is `BASE`.
  App scripts and `project_client.lua` get `app` through their environment.
  `meta/libraries.json` lists `app` for every state.
- `AppScriptsControl::terminate` dereferences `scriptCoroutine` without a
  null check (no `start.lua` and no `--script`), but nothing calls it today.
