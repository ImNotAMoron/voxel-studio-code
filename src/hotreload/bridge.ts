// Dev bridge files in `<userDir>/export/vscode/`, read by the quick-world app script
// (src/run/userdir.ts bridgeLua). Pure Node.
import * as fs from "node:fs";
import * as path from "node:path";
import { BRIDGE_ACK, BRIDGE_DIR, BRIDGE_REQUESTS, DEBUGGER_READY } from "../run/userdir";

export type BridgeRequest = { op: "reload_module"; name: string } | { op: "reload_content" };

export interface BridgeAck {
    seq: number;
    ok: boolean;
    error?: string;
}

interface RequestsFile {
    seq: number;
    requests: (BridgeRequest & { seq: number })[];
}

const KEEP = 20;

function dir(userDir: string): string {
    return path.join(userDir, ...BRIDGE_DIR.split("/"));
}

function writeAtomic(file: string, text: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

/** Appends a request; returns its sequence number. */
export function sendBridgeRequest(userDir: string, request: BridgeRequest): number {
    const file = path.join(dir(userDir), BRIDGE_REQUESTS);
    let data: RequestsFile = { seq: 0, requests: [] };
    try {
        data = JSON.parse(fs.readFileSync(file, "utf8")) as RequestsFile;
    } catch {
        // first request
    }
    const seq = (data.seq ?? 0) + 1;
    const requests = [...(data.requests ?? []), { ...request, seq }].slice(-KEEP);
    writeAtomic(file, JSON.stringify({ seq, requests }));
    return seq;
}

export function readBridgeAck(userDir: string): BridgeAck | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir(userDir), BRIDGE_ACK), "utf8")) as BridgeAck;
    } catch {
        return undefined;
    }
}

/** Waits for the app script to run request `seq` (it polls every 10 frames). */
export async function waitForAck(userDir: string, seq: number, timeoutMs = 15000): Promise<BridgeAck | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ack = readBridgeAck(userDir);
        if (ack && ack.seq >= seq) return ack;
        await new Promise((r) => setTimeout(r, 100));
    }
    return undefined;
}

export function clearDebuggerReady(userDir: string) {
    fs.rmSync(path.join(dir(userDir), DEBUGGER_READY), { force: true });
}

/** Lets a waiting quick-world script continue; `queued` = debugger messages sent. */
export function markDebuggerReady(userDir: string, queued: number) {
    writeAtomic(path.join(dir(userDir), DEBUGGER_READY), String(queued));
}
