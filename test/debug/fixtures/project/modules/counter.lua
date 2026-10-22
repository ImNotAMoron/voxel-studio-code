local counter = {}

function counter.bump(state)
    state.count = state.count + 1
    return state.count
end

return counter
