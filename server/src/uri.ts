import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** URI string in the same normal form as VS Code's `URI.file(p).toString()`. */
export function fileToUri(file: string): string {
    let p = path.resolve(file).split(path.sep).join("/");
    let drive = "";
    const m = /^([A-Za-z]):(.*)$/.exec(p);
    if (m) {
        drive = "/" + m[1].toLowerCase() + "%3A";
        p = m[2];
    }
    const encoded = p.split("/").map((seg) => seg.replace(/[^A-Za-z0-9\-._~]/g, (c) =>
        [...Buffer.from(c, "utf8")].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join(""))).join("/");
    return "file://" + drive + encoded;
}

export function uriToFile(uri: string): string | undefined {
    if (!uri.startsWith("file:")) return undefined;
    try {
        return path.resolve(fileURLToPath(uri));
    } catch {
        return undefined;
    }
}

export function fileKey(file: string): string {
    const r = path.resolve(file);
    return process.platform === "win32" ? r.toLowerCase() : r;
}
