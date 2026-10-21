local util = require "util"
local base_util = require "base:util"

function on_world_open()
    print("opened", block.index("goodpack:crate"))
end

function on_player_tick(pid, tps)
end

local function on_helper() end

function on_custom_thing()
end
on_custom_thing()
