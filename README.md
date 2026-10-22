# VoxelCore Content-Pack Tools

VS Code support for building [VoxelCore](https://github.com/MihailRis/VoxelCore)
content packs: schemas, linting, Lua API completion, VCM/VCA model support, a
live 3D model preview, and one-click runs in the engine.

## Features

- **Definition schemas**: completion, hover docs and validation for
  `blocks/`, `items/`, `entities/`, `skeletons/`, `block_materials/`,
  `preload.json`, `package.json`, generator TOML files and more. Unknown
  properties are flagged. The engine silently drops them, so a typo like
  `"emision"` is otherwise invisible.
- **Pack linter**: missing textures, models, materials, components,
  skeletons and sounds; undeclared `pack:` user properties; hidden blocks
  without `picking-item`; out-of-range values (`emission`, `hitbox`,
  `fields` size, `state-based`); misspelled Lua callbacks (`on_place`);
  engine-only libraries used in world-generator scripts; unresolved
  `require`; and more. Also available as a CLI for CI:
  `node dist/cli.js lint <packDir> [--res <engine res>]`.
- **Lua API**: definitions for every engine library (`block`, `world`,
  `entities`, `gui`, `gfx.*`, …) generated from the engine docs, wired
  into the [Lua](https://marketplace.visualstudio.com/items?itemName=sumneko.lua)
  extension.
- **VCM / VCA**: syntax highlighting, outline, completion and validation
  for model and animation files.
- **Model preview**: *VoxelCore: Open Preview* (editor title button
  on `.vcm`/`.obj`) shows the model beside the text and updates while you
  type. Click a primitive to jump to its source. `.vec3` files open in the
  3D viewer directly.
- **Block and entity preview**: the same command on a block definition
  shows the model with labelled faces (texture-faces order), hitboxes,
  rotation profiles and state-based variants; on an entity or skeleton it
  shows the skeleton in rest pose with hitbox, sensors and components.
  `parent` definitions are resolved, and edits show up while you type.
- **Scaffolding**: *New Content Pack / Block / Item / Entity / Component / Layout*
  (Command Palette, or right-click a folder → *New VoxelCore*) creates all
  related files: definition, placeholder texture, script, caption.
- **Snippets**: `vc-block`, `vc-item`, `vc-entity`, `vc-particles`,
  `vc-module`, `vc-block-script`, `box`, `bone`, `track`, …
- **Run in the engine**: *VoxelCore: Run Quick World* (status bar
  ▶ VoxelCore) links every workspace pack into a dev user dir and opens a
  dev world with them enabled. No copying into `res/content` is needed.
  Tasks of type `voxelcore` can be customized in `tasks.json`.
- **Engine errors in Problems**: the engine's output goes to the
  *VoxelCore* output channel (filterable by level). Lua errors, JSON
  parsing errors, unknown model / rotation / culling values, missing
  entity components and unresolved `parent`s are mapped back to the
  file and line in your pack, even through `user:content/...` paths.
  Repeated errors (every tick) collapse into one with a counter. Virtual
  paths like `[string "pack:scripts/x.lua"]:42` are clickable in the
  output channel, the task terminal and `latest.log`. Engines started
  outside VS Code are followed through `<userDir>/latest.log`.
- **Asset hovers**: hovering a texture name shows the texture enlarged
  without blurring, with its size and transparency. On `texture-faces`
  you see all six faces in the engine's order. Sounds list their variants
  with durations, and models show their size and triangle count with an
  *Open preview* link. Texture lines in definitions and models get a small
  thumbnail in the gutter (`voxelcore.gutterThumbnails`).
- **Locale files**: `texts/*.txt` get syntax highlighting, an outline by
  `#` sections and checks:
  - lines the engine can't parse (they stop the content from loading);
  - duplicate keys;
  - file names that aren't engine languages;
  - keys your other languages have;
  - block and item captions without a translation.

  A quick fix adds the missing keys. Hovering a `caption`, a `gui.str(...)`
  key or a locale key shows every translation.
- **XML layouts**: `layouts/**/*.xml` get completion of elements (only
  the ones the parent element reads), attributes (with value choices) and
  values, hover docs for every element and attribute (type, default,
  how Lua callbacks are run), an outline, and checks generated from the
  engine's UI reader: parse errors as the engine reports them, unsupported
  elements, attributes the element doesn't read (the engine ignores them
  silently, so `orientaton=` is otherwise invisible), ignored children
  and text, repeated attributes, and values the engine can't read
  (the layout fails to load) or reads differently than written: `size="100
  50"` is `100,100`, `visible="yes"` is false, `z-index="1.5"` is 1, a
  bad hex digit gives a wrong colour. Duplicate element ids, which hide
  `document.<id>` for everything inside the duplicate, are flagged too.
  Quick fixes rename misspellings and fix enum and boolean values.
  Colour attributes get a swatch and VS Code's colour picker; the picked
  colour is written back as hex or `r,g,b,a`, like the original. Lua in
  callback attributes (`onclick`, `consumer`, `supplier`, …) is
  highlighted as Lua. Callbacks are checked like the engine compiles them
  (`onclick="refresh"` without `()` is a syntax error the engine only
  logs), names the layout's `.xml.lua`, the engine and the pack don't
  define are flagged, and F12 on `refresh()` jumps to `function refresh`.
  Texture, model and layout names in layouts are checked, completed, shown
  on hover (with the image) and in the gutter, and take part in Find
  References and Rename; unknown key bindings are flagged. Hovering an
  `@key` text shows its translations, following the `context` attribute.
  In the layout's `.xml.lua`, `document.` completes the layout's element
  ids (the ones the engine actually indexes), with hover and F12 to the
  element. Inside `onclick` and the other callbacks, completion offers the
  script's functions (`refresh()` in event attributes, a
  `function(checked) … end` stub where the engine passes values).
  Snippets: `vc-layout`, `vc-inventory`, `vc-panel`, `vc-button`,
  `vc-label`, `vc-image`, `vc-textbox`, `vc-checkbox`, `vc-trackbar`,
  `vc-select`, `vc-slots-grid`, `vc-slot`. *New Layout…* creates a layout
  and its script. Find All References and Rename work across a layout and
  its script: a function and the callbacks that call it, an element id and
  its `document.<id>` uses. A `select` whose `selected` matches no option
  and fonts that aren't loaded (the text isn't drawn) are flagged.
- **Lua debugger**: F5 (*VoxelCore: Debug Quick World*) opens the dev
  world under the debugger. You get breakpoints in pack scripts and
  modules, the call stack, locals (expand tables at a breakpoint), hover
  values like `t.list[2]`, and stops on `error()`. The engine's output goes
  to the Debug Console. A quick world waits for your breakpoints before
  loading content, so `on_world_open` and load-time code can be debugged.
  *Debug Lua Script Headless* (editor ▷ menu) debugs an app script, and
  *Attach* connects to an engine started from VS Code or with
  `--dbg-server tcp:<port>`. The engine's VC-DBG protocol has gaps:
  stepping is emulated, and tables can only be expanded at breakpoints
  (see ENGINE_NOTES.md).
- **Hot reload**: while an engine started from VS Code runs, saving a
  texture (outside the block/item atlases), model or VCA animation reloads
  it in the engine; files changed by external editors count too. Saving a
  module runs `reload_module`, and saving a definition or script offers to
  reload content, which reopens the world (`voxelcore.hotReload.content`).
  Modules and content reload with *Run Quick World* and debug launches.
- **References and rename**: *Find All References* (Shift+F12) on any
  id in JSON, TOML, Lua (`block.index`, `require`, `audio.play_sound`,
  full `pack:name` strings) or VCM finds every use of a block, item,
  entity, texture, model, sound, skeleton, material, component, layout,
  module or script. *Rename* (F2) renames the file and updates every
  reference. A unit takes along the script, layout and skeleton it uses by
  default and keeps its place in `content.json`. Unit renames open
  VS Code's refactor preview first, because existing worlds will need to
  convert. Renaming a texture, model or other asset file in the Explorer
  updates its references too. Code lens above definitions shows the
  reference count. *Go to Symbol in Workspace* (Ctrl+T) finds content by
  id. The content explorer has *Find VoxelCore References* and *Rename
  Content…* actions, which also work on PNG and OGG files.
- **Content explorer**: a VoxelCore view in the Activity Bar.
  *Content* lists each pack's blocks, items, entities, components,
  generators, models, textures, sounds, layouts, scripts and modules,
  with texture icons and translated captions. *Dependencies* shows each
  pack's dependencies with their status and the engine's load order.
  *Engine* shows the executable, `res/`, user dir and run status, with
  run buttons.
- **Projects**: a folder with a `project.toml` (the app the engine runs
  with `--project`) is recognised. Unknown permissions, base packs the
  engine won't find, and calls that need a permission the project doesn't
  grant (`network.*`, writing to `user:`, `app.start_debug_instance`,
  `app.start_background_instance`) are flagged, with quick fixes that
  grant the permission. `project_client.lua` gets completion for its
  `on_menu_setup` / `on_level_setup` / … callbacks, and a bare `require`
  there is flagged (it fails; use `require "project:name"`). The content
  explorer shows each project with its files, permissions, base packs and
  content packs. *New Project…* creates one, and *Run Project* runs it with
  its own `start.lua`. `voxelcore` tasks and debug launches take
  `project` and `projectArgs`. Quick World and debug runs replace
  `start.lua` with their own script.
- **Pack folders in the Explorer**: pack folders get a `VC` badge and a
  colour in VS Code's Explorer (`voxelcore.explorer.packBadges`). For
  icons on `blocks`, `items`, `textures`, `scripts`, `texts` and the other
  pack folders, and on VCM, VCA, Lua, locale and asset files, pick
  *VoxelCore Content Packs* in *Preferences: File Icon Theme*. It replaces
  your current icon theme, so files of other languages get a plain icon.

## Setup

1. Build or download VoxelCore. If your workspace is inside the engine
   repo, the executable (`build/*/VoxelCore(.exe)`) and `res/` are
   detected automatically. Otherwise set `voxelcore.executable` and
   `voxelcore.resPath`.
2. Install the **Lua** extension (`sumneko.lua`) for Lua completion. On
   first use the extension offers to configure it for your packs
   (`voxelcore.configureLua`).
3. Open a folder with a content pack (any folder with a pack
   `package.json`), or run *VoxelCore: New Content Pack…*.

## Settings

| Setting | Default | Description |
|---|---|---|
| `voxelcore.executable` | auto | VoxelCore executable |
| `voxelcore.resPath` | auto | engine `res/` folder |
| `voxelcore.userDir` | workspace storage | `--dir` used for runs; packs are linked into `<userDir>/content` |
| `voxelcore.configureLua` | `ask` | configure the Lua extension for content packs |
| `voxelcore.lint.enable` | `true` | enable the pack linter |
| `voxelcore.log.tail` | `true` | follow `<userDir>/latest.log` of engines started outside VS Code |
| `voxelcore.explorer.packBadges` | `true` | `VC` badge and colour on pack folders in the Explorer |
| `voxelcore.gutterThumbnails` | `true` | texture thumbnails in the gutter of definitions and models |
| `voxelcore.hotReload.enable` | `true` | runs start with `--dbg-server`, and saved files reload in the engine |
| `voxelcore.hotReload.content` | `ask` | reload content when a definition or script is saved: `ask`, `auto`, `off` |

## Development

```sh
npm install
npm run gen        # regenerate schemas/ and meta/ from the engine repo (..)
npm run contrib    # merge contrib/*.json into package.json
npm run icons      # regenerate the file icon theme (icons/)
npm run build      # bundle to dist/
npm test           # unit + engine integration tests (uses ../build/Debug/VoxelCore if present)
npm run test:vscode  # smoke test inside the installed VS Code (extension host)
npm run package    # build a .vsix
```

Press F5 in VS Code with this folder open to start an Extension
Development Host. See [ARCHITECTURE.md](ARCHITECTURE.md) for the code
layout and [FEATURES.md](FEATURES.md) for the roadmap.
