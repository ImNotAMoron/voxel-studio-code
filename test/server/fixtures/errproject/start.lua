local helper = require "helper"
local qualified = require "project:helper"
local missing = require "no_such_module"

network.get("https://example.com", function(text) end)
print(network.is_available())
file.write("user:notes.txt", "x")
file.write("world:notes.txt", "x")
local port = app.start_debug_instance()
app.tick()
