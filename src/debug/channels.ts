// VC-DBG connections to engines started by the extension. The engine accepts
// one client, so runs and debug sessions share it: a run keeps a "keeper"
// connection for hot reload (it resumes every pause, e.g. error() calls),
// and a debug session can take it over and hand it back on detach. Pure Node.
import { EventEmitter } from "node:events";
import { VcDbgClient } from "./vcdbg";

export interface EngineChannel {
    port: number;
    /** The engine's user dir (dev bridge files live there). */
    userDir: string;
    /** The app script serves dev bridge requests (quick world). */
    bridge: boolean;
    label: string;
    client: VcDbgClient;
    owner: "keeper" | "debugger";
}

export class EngineChannels extends EventEmitter<{ change: [] }> {
    private readonly list: EngineChannel[] = [];

    all(): readonly EngineChannel[] {
        return this.list;
    }

    /** The most recent live channel. */
    current(): EngineChannel | undefined {
        for (let i = this.list.length - 1; i >= 0; i--) if (!this.list[i].client.isClosed) return this.list[i];
        return undefined;
    }

    byPort(port: number): EngineChannel | undefined {
        return this.list.find((c) => c.port === port && !c.client.isClosed);
    }

    add(channel: Omit<EngineChannel, "owner">, owner: EngineChannel["owner"]): EngineChannel {
        const entry: EngineChannel = { ...channel, owner };
        this.list.push(entry);
        channel.client.on("message", (m) => {
            // keeper: never stay paused (nobody is there to resume)
            if (m.type === "paused" && entry.owner === "keeper") channel.client.send({ type: "resume" });
        });
        channel.client.on("close", () => this.remove(entry));
        this.emit("change");
        return entry;
    }

    remove(entry: EngineChannel) {
        const i = this.list.indexOf(entry);
        if (i < 0) return;
        this.list.splice(i, 1);
        this.emit("change");
    }

    /** A debug session takes the connection over. */
    adopt(entry: EngineChannel) {
        entry.owner = "debugger";
        this.emit("change");
    }

    /** The debug session detached: the run keeps the connection. */
    release(client: VcDbgClient): boolean {
        const entry = this.list.find((c) => c.client === client);
        if (!entry || entry.client.isClosed) return false;
        entry.owner = "keeper";
        this.emit("change");
        return true;
    }
}

export const engineChannels = new EngineChannels();
