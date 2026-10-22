// VC-DBG v1.1 client (doc/specs/debugging_protocol.md, src/devtools/DebuggingServer.cpp).
// Pure Node: used by the debug adapter, hot reload and the tests.
import { EventEmitter } from "node:events";
import * as net from "node:net";

export const VCDBG_VERSION = 1;
const MAGIC = Buffer.from([0x76, 0x63, 0x2d, 0x64, 0x62, 0x67, 0x00]); // "vc-dbg\0"

export interface StackLocal {
    name: string;
    /** Index for `get-value` (`debug.getlocal` index). */
    index: number;
    type: string;
    short: string;
}

export interface StackFrame {
    function?: string;
    /** Chunk name: `pack:scripts/x.lua`, `core:modules/…`, `script:app.lua`. */
    source?: string;
    what?: string;
    line?: number;
    locals?: StackLocal[];
}

export interface PausedMessage {
    type: "paused";
    reason?: "breakpoint" | "exception" | "step";
    message?: string;
    stack?: StackFrame[];
}

export interface ValueMessage {
    type: "value";
    frame: number;
    local: number;
    path: (string | number)[];
    /** A table: key → {type, short}; else the plain value. */
    value: unknown;
}

export type ServerMessage = PausedMessage | ValueMessage | { type: "success" | "resumed" };

export type DisconnectAction = "resume" | "detach" | "terminate";

export interface VcDbgEvents {
    handshake: [];
    message: [ServerMessage];
    close: [];
}

/**
 * One connection to an engine started with `--dbg-server tcp:<port>`. The
 * engine accepts a single client and reads one message (or one length
 * prefix) per frame, so sends are queued by the socket and processed in order.
 */
export class VcDbgClient extends EventEmitter<VcDbgEvents> {
    private buffer = Buffer.alloc(0);
    private handshaken = false;
    private closed = false;

    private constructor(private readonly socket: net.Socket) {
        super();
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("close", () => {
            this.closed = true;
            this.emit("close");
        });
        socket.on("error", () => undefined);
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * Connects (retrying while the engine starts), exchanges headers and sends
     * `connect`. Resolves once the engine answers `success`.
     */
    static async connect(
        port: number,
        options: { host?: string; timeoutMs?: number; disconnectAction?: DisconnectAction; isAlive?: () => boolean } = {}
    ): Promise<VcDbgClient> {
        const host = options.host ?? "127.0.0.1";
        const deadline = Date.now() + (options.timeoutMs ?? 20000);
        for (;;) {
            if (options.isAlive && !options.isAlive()) throw new Error("the engine exited before the debugger connected");
            try {
                const socket = await new Promise<net.Socket>((resolve, reject) => {
                    const s = net.connect(port, host, () => resolve(s));
                    s.once("error", reject);
                });
                socket.setNoDelay(true);
                const client = new VcDbgClient(socket);
                await client.handshake(Math.max(1000, deadline - Date.now()));
                const success = client.next((m) => m.type === "success", 10000);
                client.send({ type: "connect", "disconnect-action": options.disconnectAction ?? "resume" });
                await success;
                return client;
            } catch (err) {
                if (Date.now() > deadline) throw new Error(`could not connect to the VoxelCore debugger on ${host}:${port}: ${(err as Error).message}`);
                await new Promise((r) => setTimeout(r, 150));
            }
        }
    }

    private handshake(timeoutMs: number): Promise<void> {
        const header = Buffer.concat([MAGIC, Buffer.from([VCDBG_VERSION])]);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.socket.destroy();
                reject(new Error("no handshake"));
            }, timeoutMs);
            this.once("handshake", () => {
                clearTimeout(timer);
                resolve();
            });
            this.socket.once("close", () => {
                clearTimeout(timer);
                reject(new Error("connection closed during handshake (version mismatch?)"));
            });
            this.socket.write(header);
        });
    }

    private onData(chunk: Buffer) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshaken) {
            if (this.buffer.length < 8) return;
            const header = this.buffer.subarray(0, 8);
            this.buffer = this.buffer.subarray(8);
            if (!header.subarray(0, 7).equals(MAGIC)) {
                this.socket.destroy();
                return;
            }
            this.handshaken = true;
            this.emit("handshake");
        }
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (this.buffer.length < 4 + length) return;
            const body = this.buffer.subarray(4, 4 + length).toString("utf8");
            this.buffer = this.buffer.subarray(4 + length);
            try {
                this.emit("message", JSON.parse(body) as ServerMessage);
            } catch {
                // malformed JSON from the engine: ignore the message
            }
        }
    }

    send(message: Record<string, unknown>) {
        if (this.closed) return;
        const body = Buffer.from(JSON.stringify(message), "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        this.socket.write(Buffer.concat([header, body]));
    }

    /** The next message matching `predicate`. */
    next(predicate: (m: ServerMessage) => boolean, timeoutMs = 30000): Promise<ServerMessage> {
        return new Promise((resolve, reject) => {
            const onMessage = (m: ServerMessage) => {
                if (!predicate(m)) return;
                cleanup();
                resolve(m);
            };
            const onClose = () => {
                cleanup();
                reject(new Error("connection closed"));
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("timeout"));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                this.off("message", onMessage);
                this.off("close", onClose);
            };
            this.on("message", onMessage);
            this.on("close", onClose);
        });
    }

    close() {
        this.closed = true;
        this.socket.end();
        this.socket.destroy();
    }
}

/** A free local TCP port for `--dbg-server tcp:<port>`. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as net.AddressInfo;
            server.close(() => resolve(port));
        });
    });
}

/** Hot-reload request for one engine path (`AssetsLoader::addReload`). */
export function hotReloadMessage(file: string): Record<string, unknown> {
    return { type: "hot-reload", file };
}
