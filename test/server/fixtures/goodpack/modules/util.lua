local M = {}

function M.clamp(x, a, b)
    return math.max(a, math.min(b, x))
end

return M
