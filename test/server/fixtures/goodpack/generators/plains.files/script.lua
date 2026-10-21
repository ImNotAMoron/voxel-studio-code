local util = require "goodpack:util"

function generate_heightmap(x, y, w, h, bpd, inputs)
    local map = Heightmap(w, h)
    map.noiseSeed = SEED
    map:noise({x, y}, 0.02 * bpd, 4)
    return map
end

function place_structures(x, z, w, d, hmap, chunk_height)
    local stone = block.index("base:stone")
    return {}
end
