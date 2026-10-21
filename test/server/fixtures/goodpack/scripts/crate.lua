function on_interact(x, y, z, playerid)
    return true
end

function on_placed(x, y, z, playerid)
    audio.play_sound("crate/open", x, y, z, 1.0, 1.0)
end
