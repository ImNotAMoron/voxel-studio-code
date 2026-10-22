// Engine callbacks per script kind.
// Sources: doc/en/scripting/events.md, doc/en/scripting/ecs.md,
// doc/en/world-generator.md and the registration code
// (src/logic/scripting/scripting.cpp register_event, scripting_hud.cpp,
// scripting_entities.cpp, res/modules/internal/stdcomp.lua); project scripts:
// src/devtools/AppScriptsControl.cpp, scripting.cpp (LuaProjectScript).

export type ScriptKind =
    | "block" | "item" | "unit" | "world" | "hud" | "content" | "component"
    | "layout" | "generator" | "module" | "app" | "project" | "other";

export interface Callback {
    name: string;
    params: string[];
    doc: string;
}

const cb = (name: string, params: string, doc: string): Callback => ({
    name,
    params: params ? params.split(",").map((s) => s.trim()) : [],
    doc,
});

export const BLOCK_CALLBACKS: Callback[] = [
    cb("on_placed", "x, y, z, playerid", "Called on block placed by player."),
    cb("on_broken", "x, y, z, playerid", "Called on block broken by player."),
    cb("on_replaced", "x, y, z, playerid", "Called before a player replaces a block."),
    cb("on_interact", "x, y, z, playerid", "Called on block RMB click interaction. Prevents block placing if **true** returned."),
    cb("on_update", "x, y, z", "Called on block update (near block changed)."),
    cb("on_random_update", "x, y, z", "Called on random block update (grass growth)."),
    cb("on_blocks_tick", "tps", "Called tps (20 / tick-interval) times per second. Use 1/tps instead of `time.delta()`."),
    cb("on_block_tick", "x, y, z, tps", "Called tps (20 / tick-interval) times per second for a block."),
    cb("on_block_present", "x, y, z", "Called for a specific block when it appears in the world (generated/loaded/placed)."),
    cb("on_block_removed", "x, y, z", "Called when chunk containing the block unloads."),
    cb("on_breaking", "x, y, z, playerid", "Called while the block is being broken (registered by the engine, undocumented)."),
];

export const ITEM_CALLBACKS: Callback[] = [
    cb("on_use", "playerid", "Called on RMB click out of a block."),
    cb("on_use_on_block", "x, y, z, playerid, normal", "Called on block RMB click. Prevents **placing-block** placing if returns **true**."),
    cb("on_block_break_by", "x, y, z, playerid", "Called on block LMB click (unbreakable blocks included). Prevents block destruction if returns **true**."),
];

export const WORLD_CALLBACKS: Callback[] = [
    cb("on_world_open", "", "Called on world open."),
    cb("on_world_save", "", "Called before world save."),
    cb("on_world_tick", "tps", "Called 20 times per second."),
    cb("on_world_quit", "", "Called on world close (after saving)."),
    cb("on_block_placed", "blockid, x, y, z, playerid", "Called on block placed by player."),
    cb("on_block_replaced", "blockid, x, y, z, playerid", "Called on block replaced with other by player."),
    cb("on_block_breaking", "blockid, x, y, z, playerid", "Called while a block is being broken (registered by the engine, undocumented)."),
    cb("on_block_broken", "blockid, x, y, z, playerid", "Called on block broken by player."),
    cb("on_block_interact", "blockid, x, y, z, playerid", "Called on block RMB click interaction. Prevents block placing if **true** returned."),
    cb("on_player_tick", "playerid, tps", "Called tps (20) times per second."),
    cb("on_chunk_present", "x, z, loaded", "Called after a chunk is generated/loaded."),
    cb("on_chunk_remove", "x, z", "Called when a chunk is unloaded from the world."),
    cb("on_inventory_open", "invid, playerid", "Called when the inventory is opened."),
    cb("on_inventory_closed", "invid, playerid", "Called when the inventory is closed."),
    cb("on_entity_spawn", "uid", "Called after an entity is spawned."),
    cb("on_entity_despawn", "uid", "Called before an entity is despawned."),
];

export const HUD_CALLBACKS: Callback[] = [
    cb("on_hud_open", "playerid", "Called after world open."),
    cb("on_hud_render", "", "Called every frame."),
    cb("on_hud_close", "playerid", "Called on world close (before saving)."),
    cb("on_inventory_interact", "invid, slot, action, mode", "Triggered when a player interacts with inventory slots."),
];

export const CONTENT_CALLBACKS: Callback[] = [
    cb("on_scripts_loading", "", "Called before the content pack scripts are loaded."),
    cb("on_content_loaded", "", "Called after the content pack has been fully loaded."),
];

export const COMPONENT_CALLBACKS: Callback[] = [
    cb("on_despawn", "", "Called when the entity is despawned."),
    cb("on_grounded", "force", "Called on landing; force is the hit strength."),
    cb("on_fall", "", "Called when the entity starts falling."),
    cb("on_save", "", "Called before the component data is saved (store data in SAVED_DATA)."),
    cb("on_update", "tps", "Called every entities tick."),
    cb("on_physics_update", "delta", "Called after each physics step."),
    cb("on_render", "delta", "Called every frame before rendering."),
    cb("on_sensor_enter", "index, entity", "Called when another entity enters a sensor."),
    cb("on_sensor_exit", "index, entity", "Called when another entity leaves a sensor."),
    cb("on_aim_on", "playerid", "Called when a player aims at the entity."),
    cb("on_aim_off", "playerid", "Called when a player stops aiming at the entity."),
    cb("on_attacked", "attackerid, playerid", "Called when the entity is attacked (LMB)."),
    cb("on_used", "playerid", "Called when the entity is used (RMB)."),
    cb("on_player_set", "playerid", "Called when a player is bound to the entity."),
    cb("on_enable", "", "Called by entity:set_enabled(name, true) (stdcomp.lua)."),
    cb("on_disable", "", "Called by entity:set_enabled(name, false) (stdcomp.lua)."),
];

export const LAYOUT_CALLBACKS: Callback[] = [
    cb("on_open", "invid, x, y, z", "Called on element added to the screen."),
    cb("on_close", "invid", "Called on element removed from the screen."),
    cb("on_progress", "done, total", "Called with the progress of a background task (layouts with a progress)."),
    cb("on_destroy", "", "Called when the document is destroyed."),
];

export const GENERATOR_CALLBACKS: Callback[] = [
    cb("generate_heightmap", "x, y, w, h, bpd, inputs", "Generates the heightmap (returns Heightmap)."),
    cb("generate_biome_parameters", "x, y, w, h, bpd", "Returns one Heightmap per biome parameter."),
    cb("place_structures", "x, z, w, d, hmap, chunk_height", "Returns an array of structure placements for a chunk."),
    cb("place_structures_wide", "x, z, w, d, chunk_height", "Returns structure/tunnel placements outside the chunk."),
];

// LuaProjectScript::onScreenChange: `on_<Screen::getName()>_setup/_clear`, no arguments,
// errors are logged (call_nothrow). Screens: MenuScreen "menu", LevelScreen "level".
export const PROJECT_CALLBACKS: Callback[] = [
    cb("on_menu_setup", "", "Called when the main menu screen is shown (also at start-up). `res/project` shows the menu here: `menu.page = \"main\"; menu.visible = true`."),
    cb("on_menu_clear", "", "Called when the main menu screen is replaced (a world opens)."),
    cb("on_level_setup", "", "Called when a world screen is shown."),
    cb("on_level_clear", "", "Called when the world screen is replaced (back to the menu)."),
];

export function callbacksFor(kind: ScriptKind): Callback[] | undefined {
    switch (kind) {
        case "block": return BLOCK_CALLBACKS;
        case "item": return ITEM_CALLBACKS;
        case "unit": return [...BLOCK_CALLBACKS, ...ITEM_CALLBACKS];
        case "world": return WORLD_CALLBACKS;
        case "hud": return HUD_CALLBACKS;
        case "content": return CONTENT_CALLBACKS;
        case "component": return COMPONENT_CALLBACKS;
        case "layout": return LAYOUT_CALLBACKS;
        case "generator": return GENERATOR_CALLBACKS;
        case "project": return PROJECT_CALLBACKS;
        default: return undefined;
    }
}

export const KIND_LABEL: Record<ScriptKind, string> = {
    block: "a block script",
    item: "an item script",
    unit: "a block/item script",
    world: "a world script (scripts/world.lua)",
    hud: "a HUD script (scripts/hud.lua)",
    content: "a content script (scripts/content.lua)",
    component: "an entity component",
    layout: "a layout script",
    generator: "a generator script",
    module: "a module",
    app: "an app script (project start.lua)",
    project: "a project client script (project_client.lua)",
    other: "a script",
};

/** Which kinds define a callback (for "this is a world.lua callback" hints). */
export function kindsDefining(name: string): ScriptKind[] {
    const kinds: ScriptKind[] = [];
    for (const kind of ["block", "item", "world", "hud", "content", "component", "layout", "generator", "project"] as ScriptKind[]) {
        if (callbacksFor(kind)!.some((c) => c.name === name)) kinds.push(kind);
    }
    return kinds;
}

/**
 * Globals missing in generator Lua states (lua_engine.cpp::create_libs opens
 * these only for BASE/SCRIPT states; stdlib.lua isn't run for generators;
 * ffi is removed in lua::init_state).
 */
export const GENERATOR_FORBIDDEN = new Set([
    "assets", "audio", "console", "core", "gui", "input", "inventory", "network",
    "pathfinding", "player", "time", "world", "entities", "cameras", "ffi", "hud",
    "gfx", "rules", "session", "events", "app", "menu", "document", "stdcomp",
    "gui_util", "Document", "Element", "RadioGroup", "start_coroutine", "sleep",
    "__skeleton", "__rigidbody", "__transform",
]);

export interface DeprecatedEntry {
    name: string;
    alternative: string;
}

/** Fallback copy of res/modules/internal/deprecated.lua. */
export const DEPRECATED_FALLBACK: DeprecatedEntry[] = [
    ["block_index", "block.index"], ["block_name", "block.name"], ["blocks_count", "block.defs_count"],
    ["is_solid_at", "block.is_solid_at"], ["is_replaceable_at", "block.is_replaceable_at"],
    ["set_block", "block.set"], ["get_block", "block.get"], ["get_block_X", "block.get_X"],
    ["get_block_Y", "block.get_Y"], ["get_block_Z", "block.get_Z"],
    ["get_block_states", "block.get_states"], ["set_block_states", "block.set_states"],
    ["get_block_rotation", "block.get_rotation"], ["set_block_rotation", "block.set_rotation"],
    ["get_block_user_bits", "block.get_user_bits"], ["set_block_user_bits", "block.set_user_bits"],
    ["load_script", "require or loadstring"], ["dofile", "require or loadstring"],
].map(([name, alternative]) => ({ name, alternative }));

/** Parses deprecated.lua (wrap_deprecated(...) assignments + on_deprecated_call). */
export function parseDeprecated(source: string): DeprecatedEntry[] {
    const result: DeprecatedEntry[] = [];
    const wrap = /^(\w+)\s*=\s*wrap_deprecated\([^,]+,\s*"(\w+)",\s*"([^"]+)"\)/gm;
    let m: RegExpExecArray | null;
    while ((m = wrap.exec(source))) result.push({ name: m[1], alternative: m[3] });
    const fn = /^function\s+(\w+)\s*\([^)]*\)\s*\n\s*on_deprecated_call\("(\w+)",\s*"([^"]+)"\)/gm;
    while ((m = fn.exec(source))) result.push({ name: m[1], alternative: m[3] });
    return result;
}

/** Functions whose first string argument is a content/asset id (completion, go-to). */
export const ID_CALLS: Record<string, "block" | "item" | "entity" | "sound" | "layout" | "module"> = {
    "block.index": "block",
    "item.index": "item",
    "entities.spawn": "entity",
    "entities.def_index": "entity",
    "audio.play_sound": "sound",
    "audio.play_sound_2d": "sound",
    "hud.show_overlay": "layout",
    "hud.open_permanent": "layout",
    "require": "module",
};
