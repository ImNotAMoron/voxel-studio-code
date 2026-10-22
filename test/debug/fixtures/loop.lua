local function helper(x)
    local y = x + 1
    return y * 2
end
local function work(n)
    local t = {a = n, list = {10, 20}}
    local s = helper(n)
    s = s + 1
    return s
end
for i = 1, 100000 do
    local r = work(i)
    if i == 30000 then error("fixture error") end
    app.tick()
end
