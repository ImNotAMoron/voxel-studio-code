// Virtual-path links in engine log text (Output channel, task terminal,
// latest.log). Pure.

export interface LogLink {
    /** Offset in the line. */
    start: number;
    length: number;
    vpath: string;
    /** 1-based. */
    line?: number;
}

const PATTERNS: RegExp[] = [
    // Lua chunk locations: [string "base:scripts/x.lua"]:42
    /\[string "([^"]+)"\](?::(\d+))?/g,
    // loader errors: file "user:content/x/blocks/a.json" / in file 'x:y.json'
    /\bfile ["']([\w-]+:[^"']+)["']/g,
    // bare virtual paths with an extension, optionally :line
    /(?<![\w"'/\\-])((?:[a-z_][\w-]*):(?!\/\/)[\w./-]+\.[a-z0-9]+)(?::(\d+))?/gi,
];

export function findLogLinks(text: string): LogLink[] {
    const links: LogLink[] = [];
    const taken: [number, number][] = [];
    const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
    for (const re of PATTERNS) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            const start = m.index ?? 0;
            const end = start + m[0].length;
            if (overlaps(start, end)) continue;
            // drive letters (C:\...) aren't virtual paths
            if (/^[a-z]$/i.test(m[1].split(":")[0])) continue;
            taken.push([start, end]);
            links.push({ start, length: m[0].length, vpath: m[1], line: m[2] ? Number(m[2]) : undefined });
        }
    }
    return links.sort((a, b) => a.start - b.start);
}
