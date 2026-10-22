// Durations of sound assets for hovers (FEATURES.md §3.9). Pure.

/** Seconds of an Ogg Vorbis file: last page's granule position / sample rate. */
export function oggDuration(buf: Buffer): number | undefined {
    if (buf.length < 58 || buf.toString("ascii", 0, 4) !== "OggS") return undefined;
    // identification header: "\x01vorbis" in the first page's packet
    const vorbis = buf.indexOf("\x01vorbis", 0, "latin1");
    if (vorbis < 0 || vorbis + 16 > buf.length) return undefined;
    const rate = buf.readUInt32LE(vorbis + 12);
    if (!rate) return undefined;
    for (let pos = buf.lastIndexOf("OggS"); pos >= 0; pos = pos > 0 ? buf.lastIndexOf("OggS", pos - 1) : -1) {
        if (pos + 14 > buf.length) continue;
        const granule = buf.readBigInt64LE(pos + 6);
        if (granule > 0n) return Number(granule) / rate;
    }
    return undefined;
}

/** Seconds of a PCM WAV file (data chunk size / byte rate). */
export function wavDuration(buf: Buffer): number | undefined {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return undefined;
    let byteRate = 0;
    for (let pos = 12; pos + 8 <= buf.length;) {
        const id = buf.toString("ascii", pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        if (id === "fmt ") byteRate = buf.readUInt32LE(pos + 16);
        if (id === "data") return byteRate ? size / byteRate : undefined;
        pos += 8 + size + (size & 1);
    }
    return undefined;
}

export function formatDuration(seconds: number | undefined): string {
    if (seconds === undefined) return "?";
    return seconds < 10 ? `${seconds.toFixed(2)} s` : `${seconds.toFixed(1)} s`;
}
