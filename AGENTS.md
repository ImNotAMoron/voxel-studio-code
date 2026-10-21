# AGENTS.md — VoxelCore VS Code extension

Guide for AI coding agents working in `vscode-extension/`. Read this first.
The engine-wide guide is [../AGENTS.md](../AGENTS.md); deep dives on engine
subsystems are in [../doc/agents/](../doc/agents/).

## What this is

`voxelcore-tools`: a VS Code extension for building VoxelCore **content
packs**. It's TypeScript end to end: the extension host, the language server
(`vcls`), the CLI linter and a three.js webview. The engine itself isn't
modified by this work.

| Doc | Read it for |
|---|---|
| [FEATURES.md](FEATURES.md) | the roadmap: every feature, its priority, design notes and **status** |
| [ARCHITECTURE.md](ARCHITECTURE.md) | code layout, module ownership, interfaces between parts, data flow |
| [ENGINE_NOTES.md](ENGINE_NOTES.md) | engine bugs and doc/code mismatches found so far (upstream issue candidates) |
| [README.md](README.md) | user-facing description and settings |

**Status (2026-10-22):** the MVP is complete. All P0 features in
FEATURES.md work: 383 tests pass, 9/9 checks pass in real VS Code, and the
`.vsix` packages. The next work is the **P1** features (see "Where to
continue" below).

## Commands

Run from `vscode-extension/`:

```sh
npm install
npm run gen          # regenerate schemas/ + meta/ from the engine repo (..); commit the output
npm run contrib      # merge contrib/*.json into package.json
npm run build        # esbuild → dist/{extension,server,cli,webview}.js
npm run typecheck    # tsc for host/server/shared + webview (two tsconfigs)
npm test             # node:test via tsx — all unit + engine integration tests
npm run test:vscode  # build + smoke test inside the installed VS Code (tools/vscode-smoke.mjs)
npm run package      # production build + .vsix
node dist/cli.js lint ../packs/backrooms --res ../res   # CLI linter
node dist/cli.js rules                                  # list lint rules
```

Single suite: `node --import tsx --test test/server/rules.test.ts`.

Debug in VS Code: open `vscode-extension/` and press F5 (*Run Extension
(engine repo)*, which opens the engine repo as the workspace). Use *Attach to
Language Server* (port 6019) to debug `vcls`.

## Definition of done for a change

1. `npm run typecheck` is clean.
2. `npm test` passes, with new tests for new behaviour. Rules need a
   positive fixture; the registry coverage test fails otherwise.
3. **Zero noise**: no errors or warnings on `../res/content/base` or
   `../packs/backrooms` (the server tests check this). Fix the rule, not the
   packs.
4. `npm run test:vscode` passes if you touched activation, the manifest,
   the preview or the language client.
5. If engine sources or docs were used: `npm run gen` leaves no diff. The
   tests fail when `schemas/` or `meta/` are stale.
6. FEATURES.md status updated, and ENGINE_NOTES.md updated if you found an
   engine bug.

## Rules of the road

- **Manifest**: never hand-edit `contributes` / `activationEvents` in
  `package.json`. Edit `contrib/<area>.json`, then run `npm run contrib`.
  `contrib/integration.json` may also set top-level fields.
- **No `vscode` imports** in `shared/`, `server/`, `tools/`, or in modules
  that unit tests load. Pure logic goes in a separate file next to the
  vscode glue: `src/packs.manifest.ts`, `src/lua/settings.ts`,
  `src/schemas/associations.ts`, `src/run/userdir.ts`,
  `src/scaffold/templates.ts`.
- **The engine is the source of truth.** Read the C++ loader or Lua
  runtime before encoding a rule, schema key or default. The docs are
  sometimes wrong (see ENGINE_NOTES.md). Cite the doc or source in rule
  `codeDescription` links.
- **Generated files are committed** (`schemas/`, `meta/`,
  `contrib/schemas.json`) so the extension works without engine sources. To
  change them, edit the generator or `tools/schema-overlay/*`, never the
  output.
- **Precision over coverage** in the linter: when unsure, emit nothing or a
  hint.
- Style: TypeScript strict, 4-space indent, double quotes. Match the
  surrounding file. Comments explain *why*, briefly.

## Pitfalls already hit

- **jsonc-parser in esbuild bundles**: its UMD `main` breaks
  (`Cannot find module './impl/format'`). Every node target in
  `esbuild.mjs` sets `mainFields: ["module", "main"]`. Keep it.
- `vscode.QuickPickItem` has a `kind` property (the separator enum). Don't
  put your own `kind` field on quick-pick items.
- `webview/tsconfig.json` includes only `shared/models` and `shared/vcm`.
  `shared/content` uses Node APIs and must not be pulled into the browser
  bundle.
- Preview textures are sent as **data URIs** (up to 1 MB), so WebGL doesn't
  depend on the webview resource server's CORS headers.
- `npm run package` deletes `dist/` first; otherwise stale `.map` files end
  up in the `.vsix`.
- Pack links in the dev user dir are **junctions on Windows** (no admin
  rights needed). `syncPackLinks` only ever removes links, never real
  folders.
- Workspace discovery skips folders named `fixtures`, `node_modules`, `.git`,
  `build` and `dist`, so test fixture packs don't show up in a user's lint.
- VS Code `jsonValidation` globs can't detect a pack root.
  `package.json`/`content.json` of packs outside a `content/` folder, and all
  TOML schemas (Even Better TOML only resolves absolute URLs), are
  associated through workspace settings by `src/schemas/`. This only happens
  with the same consent as the Lua configuration (`voxelcore.configureLua`).
- `assets.parse_model` doesn't work headless. The preview golden test uses
  a C++ dumper linked against the engine (`test/preview/dumper/`); its
  regeneration steps are in the `golden.test.ts` header.
- Engine-dependent tests skip themselves when `../build/Debug/VoxelCore(.exe)`
  doesn't exist. They need `../packs/backrooms` as a real-world fixture pack.

## Where to continue

P1 features from FEATURES.md, in a sensible order (each is independent):

1. §3.5 navigation extras: find references and rename (definition,
   completion and symbols already exist in `server/src/features/refs.ts`).
2. §3.9 texture hover previews (scaled PNG in hover markdown) and gutter
   thumbnails.
3. §4.3 engine log → Problems (parse `latest.log` / task output; map
   `pack:path` back to files with the content index).
4. §4.2 hot reload and §4.4 debugger, both over the VC-DBG protocol
   (`../doc/specs/debugging_protocol.md`). Write one socket client in
   `src/debug/` and share it.
5. §3.6 locale checks (keys are already indexed), §3.7 XML layout schema.
6. §3.10 content explorer tree view; §5.3/§5.4 skeleton/animation and block
   previews (reuse `shared/models` + `webview/`).

Known gaps in what exists are listed per feature in FEATURES.md (status
notes) and at the end of ARCHITECTURE.md.
