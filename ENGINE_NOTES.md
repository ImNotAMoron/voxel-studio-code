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
