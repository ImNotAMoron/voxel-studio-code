# Changelog

## Unreleased

- Projects: `project.toml`, `start.lua`, `project_client.lua` and `content/` packs are indexed; rules VC0500–VC0504 (permissions, base packs, permission-gated calls, bare `require` in the client script) with quick fixes; project callbacks and modules; projects in the content explorer; *New Project…*, *Run Project*; `project` / `projectArgs` in tasks and debug launches; `project:` chunks in logs and the debugger; the CLI lints project folders.
- XML layouts: element data generated from `gui_xml.cpp`; an `xml::parse` port; rules VC0400–VC0409 (structure, attribute values, element ids) with quick fixes; colour picker; Lua highlighting in callback attributes; callback syntax and undefined-name checks, go to definition into `.xml.lua`; texture/model/layout/binding names (checks, hovers, thumbnails, references, rename); `@key` translation hovers; `document.<id>` completion in `.xml.lua`; callback completion; XML snippets; *New Layout…*; references and rename across a layout and its script; `select` value and font checks; completion, hover and outline for `layouts/**/*.xml`.
- Explorer: `VC` badge and colour on pack folders (`voxelcore.explorer.packBadges`); optional *VoxelCore Content Packs* file icon theme for pack folders and file types.
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
