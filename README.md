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
- **Scaffolding**: *New Content Pack / Block / Item / Entity / Component*
  (Command Palette, or right-click a folder → *New VoxelCore*) creates all
  related files: definition, placeholder texture, script, caption.
- **Snippets**: `vc-block`, `vc-item`, `vc-entity`, `vc-particles`,
  `vc-module`, `vc-block-script`, `box`, `bone`, `track`, …
- **Run in the engine**: *VoxelCore: Run Quick World* (status bar
  ▶ VoxelCore) links every workspace pack into a dev user dir and opens a
  dev world with them enabled. No copying into `res/content` is needed.
  Tasks of type `voxelcore` can be customized in `tasks.json`.

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

## Development

```sh
npm install
npm run gen        # regenerate schemas/ and meta/ from the engine repo (..)
npm run contrib    # merge contrib/*.json into package.json
npm run build      # bundle to dist/
npm test           # unit + engine integration tests (uses ../build/Debug/VoxelCore if present)
npm run test:vscode  # smoke test inside the installed VS Code (extension host)
npm run package    # build a .vsix
```

Press F5 in VS Code with this folder open to start an Extension
Development Host. See [ARCHITECTURE.md](ARCHITECTURE.md) for the code
layout and [FEATURES.md](FEATURES.md) for the roadmap.
