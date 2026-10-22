local function fail(reason)
    error("fixture error: " .. reason)
end
for i = 1, 20 do
    app.tick()
end
local ok = pcall(fail, "caught")
for i = 1, 100000 do
    app.tick()
end
