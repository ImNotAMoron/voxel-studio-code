local greet = require "hotpack:greet"
local ticks = 0
function on_world_tick()
    ticks = ticks + 1
    if ticks % 10 == 0 then print("greet " .. greet.msg()) end
end
