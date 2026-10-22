local counter = require "project:counter"
local state = {count = 0}
for i = 1, 100000 do
    local n = counter.bump(state)
    app.tick()
end
app.quit()
