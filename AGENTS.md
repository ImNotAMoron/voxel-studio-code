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

**Status (2026-10-23):** the MVP is complete. All P0 features in
FEATURES.md work: 413 tests pass, 11/11 checks pass in real VS Code, and the
`.vsix` packages. Done since: block (§5.4) and entity (§5.8) previews,
engine log → Problems (§4.3), content explorer (§3.10), references and
rename (§3.5), hot reload (§4.2), the Lua debugger (§4.4), asset hovers
(§3.9), locale files (§3.6), Explorer pack-folder icons, §3.7 XML
layouts (all but the archived previews) and §3.11 projects. Now 595 tests
and 21/21 smoke checks.
The next work is the remaining **P1** features (see "Where to continue"
below).

## Commands

Run from `vscode-extension/`:

```sh
npm install
npm run gen          # regenerate schemas/, meta/ and shared/layouts/elements.json from the engine repo (..); commit the output
npm run contrib      # merge contrib/*.json into package.json
npm run icons        # regenerate the file icon theme icons/ from tools/gen-icons.mjs; commit the output
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
  `src/scaffold/templates.ts`, `src/explorer/model.ts`.
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
- `assets.parse_model` doesn't work headless. The preview golden tests use
  C++ dumpers linked against the engine (`test/preview/dumper/`:
  `dump_models`, `dump_blocks`); regeneration steps are in the
  `golden.test.ts` and `block.test.ts` headers.
- Definition previews must port the engine's quirks too (inherited
  state-based variants, size → aabb, model naming): see ENGINE_NOTES.md and
  the comments in `shared/models/block.ts` / `entity.ts`.
- The engine log format and error texts are matched by regexes in
  `shared/log/problems.ts`. When you add a pattern, record a real log
  (steps in the `test/log/log.test.ts` header) instead of writing one by
  hand: several messages differ from the C++ source at first sight (Lua
  prefixes, the `error()` wrapper location, parse positions off by one).
- Headless app scripts that throw never exit (ENGINE_NOTES.md). Engine runs in
  tests need a timeout; the smoke test's script ends with `app.quit()`.
- `merge-contrib` keys menu entries (with `when`/`group`) by their whole
  JSON, so one command can appear in several menu groups.
- References: a new reference kind needs both extraction (`jsonRefKind` /
  `luaCallKind` in `refs.ts`, or `extractRefs`) and resolution
  (`resolveRef`). Find references and rename follow automatically. Any
  `pack:name` string counts as a unit id, so exclude look-alikes (tag
  names, TOML keys) at extraction.
- VS Code runs `willRenameFiles` participants for file renames inside a
  WorkspaceEdit too, our own rename edits included. `navigation.ts`
  `ownRenames` skips those; keep it, or references get rewritten twice.
- **VC-DBG quirks** (ENGINE_NOTES.md) shape `src/debug/session.ts`:
  - the engine's `step` breaks after one use, so all stepping is built from
    `step-into-function`;
  - `get-value` at a step or `error()` pause runs the program on;
  - there's no `pause`;
  - every `error()` pauses while any client is connected (the hot-reload
    keeper must resume);
  - a step onto a breakpoint line pauses twice.

  Test against the real engine (`test/debug/debug.test.ts`), not a mock:
  each of these was found that way.
- DAP `initialized` must come after launch/attach: VS Code sends
  `setBreakpoints` right after it, and chunk names of headless scripts
  (`script:<name>`) are known only once the launch resolved the script.
- App scripts can only write to `world:`, `export:` and `config:`, which is
  why the dev bridge lives in `<userDir>/export/vscode/`. Asset
  `hot-reload` needs `user:content/<pack>/…` paths.
- Locale semantics: the engine shows a missing key as the key itself, so
  the fallback language (`en_US`) is never "missing" anything, and `base`
  ships no `en_US.txt`. Only the selected language and the fallback are
  parsed at runtime: errors in other files hide until someone switches.
- Hover markdown images are data URIs (no cache dir in the server). Command
  links must be added to `HOVER_COMMANDS` in `src/extension.ts`, or VS Code
  won't run them.
- XML layout data (`shared/layouts/elements.json`) is generated from
  `gui_xml.cpp` by `tools/gen-layouts.mjs`. It lives in `shared/`, not
  `meta/` or `schemas/`, because `gen-lua-meta` wipes `meta/` and
  `gen-schemas` deletes unknown files in `schemas/`. The generator fails
  on a `scripting::create_*` factory or value method it doesn't know: add
  it to `LUA_FACTORIES` / `VALUE_TYPES`, don't loosen the check.
- The layout parser (`shared/layouts/xml.ts`) must stay engine-exact up to
  the first error: `peek()` skips whitespace, `goBack` after the
  declaration check, escapes via `parseString`. Expected results in
  `test/layouts/xml.test.ts` were produced by `xml.parse` in a headless
  engine; re-check new cases the same way rather than guessing.
  `XmlError.pos` is the engine's position (often one past the culprit),
  `span` is what we highlight.
- Layout value checks model the engine's readers (`shared/layouts/values.ts`):
  `util::parse_double` is `from_chars` on a *prefix* (`5abc` is 5, no
  error), `std::stoll` likewise; only text with no leading number throws.
  Flag a value as an error only when the engine throws.
- Layout callbacks: chunks compile as is, expressions as `"return " ..
  value` (`lua::eval`, no parentheses: `size-func="-1, 40"` returns two
  values). VC0411 is deliberately conservative: a name assigned in *any*
  Lua file of the pack counts as defined (it may reach `_G`).
- Layout names (`layoutNames.ts`) are checked *before* the file's own
  content symbol in references/rename: `symbolAt` falls back to the file's
  symbol anywhere in a file, which would hide a function or id under the
  cursor. In a `.xml.lua`, VS Code may pick the Lua extension's rename
  provider instead of ours; renaming from the `.xml` always updates both.
- An `<image>` with a missing or unloaded texture still draws: Batch2D
  binds a blank texture, so it's a plain rectangle of the element's colour.
  Plain texture names must be in some `preload.json` `textures` list to be
  loaded; `atlas:name` uses an atlas.
- TextMate: the earliest match start wins and an `L:` injection only wins
  ties, so the Lua-attribute injection starts at the whitespace before the
  name, like xml.tmLanguage's attribute rule. Check grammar changes with
  `_workbench.captureSyntaxTokens` (the smoke test does).
- `icons/` is generated: edit `tools/gen-icons.mjs`, never the SVGs. A
  repeated attribute on one SVG element makes the icon vanish silently
  (the icons test checks this). An icon theme replaces the user's whole
  theme, so it maps common languages too; `.json`/`.txt` go by
  `languageIds` so `texts/*.txt` (vclang) keeps its own icon.
- Projects (`shared/content/project.ts`): project files belong to no pack
  (`res/project` lies inside the core pack's folder), so `fileRole` checks
  `index.projectFile` first and `lintLua` runs on them with a placeholder
  pack. Chunk names differ: `project:start.lua`, but `project_client.lua`
  is loaded as its bare file name, so a bare `require` there throws. Headless,
  a project's own `start.lua` stops at its first wait (`ServerMainloop`
  needs `--script`), so engine tests pass it as the `--script` too.
- Engine-dependent tests skip themselves when `../build/Debug/VoxelCore(.exe)`
  doesn't exist. They need `../packs/backrooms` as a real-world fixture pack.

## Where to continue

P1 features from FEATURES.md, in a sensible order (each is independent):

1. §4.5 test explorer (debug profile = a `voxelcore` launch with
   `mode: "headless"`) and §4.6 console bridge, which could also serve
   module/content reload for *Run engine* (`src/hotreload/index.ts`).
2. Locale extras: rename a unit's default caption key with the unit
   (`ReferenceIndex.planRename` + `shared/content/locale.ts`), the
   Translations webview.
3. §5.3 VCA animation playback on top of
   the §5.8 skeleton view (`shared/models/entity.ts boneMatrices` takes the
   pose; reuse `webview/`).
4. §3.7 XML layouts (steps 1–4 done: element data in `shared/layouts/`,
   the parser port, rules VC0400–VC0409, completion/hover/outline, colour
   picker, Lua callbacks and their completion, names/references/thumbnails,
   `@key` hovers, `document.<id>` in `.xml.lua`, snippets, *New Layout*).
   Everything but the archived previews is done (layout preview,
   engine-rendered layouts, XML models; see FEATURES.md §3.7). XML `@key` texts
   should get `translationsHover`, and XML textures `textureHover`. Add XML texture /
   layout references to `extractRefs` in `server/src/features/references.ts`
   then.

Known gaps in what exists are listed per feature in FEATURES.md (status
notes) and at the end of ARCHITECTURE.md.
