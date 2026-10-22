# Changelog

## Unreleased

- Asset hovers: texture thumbnails (nearest-neighbour), texture-faces in engine order, sound variants with durations, model facts; gutter thumbnails.
- Locale files: `vclang` language, outline, rules VC0300–VC0304 with a stub quick fix, translation hovers.
- Lua debugger (`voxelcore` debug type): launch quick world / menu / headless script, attach; breakpoints, stepping, locals, hover values, `error()` stops, Debug Console.
- Hot reload: assets over VC-DBG, modules and content through the quick-world dev bridge; `voxelcore.hotReload.*` settings.
- References and rename: find references, rename (files + references, unit defaults, `content.json` order kept, refactor preview for units), rename-on-file-move from the Explorer, workspace symbols, reference-count code lens, explorer actions.
- Engine log → Problems: engine output in the *VoxelCore* output channel with levels, runtime errors mapped to pack files (Lua errors, loader errors, enum values, components, parents), clickable virtual paths, `latest.log` tailing (`voxelcore.log.tail`).
- Content explorer: *Content*, *Dependencies* (with the engine's load order) and *Engine* views in a VoxelCore Activity Bar container.
- Block and entity previews.

## 0.1.0

- First MVP: definition schemas, pack linter (`vcls` + CLI), Lua API definitions for sumneko.lua, VCM/VCA language support, live model preview (VCM/OBJ/vec3), scaffolding commands and snippets, run packs in the engine (quick world).
