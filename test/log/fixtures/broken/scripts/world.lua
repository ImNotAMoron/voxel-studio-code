function on_world_open()
    entities.spawn("broken:bot", {0, 90, 0})
    local t = nil
    print(t.field)
end

local ticks = 0
function on_world_tick()
    ticks = ticks + 1
    if ticks == 2 then require "broken:nomodule" end
    error("tick failure")
end
