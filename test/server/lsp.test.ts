// Real LSP smoke test: bundle the server, spawn it over stdio, open a block
// with a bad texture and wait for publishDiagnostics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { fileToUri } from "../../server/src/uri";
import { EXT_ROOT, GOODPACK, RES } from "./helpers";

class Client {
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private pending = new Map<number, (result: unknown) => void>();
    readonly notifications: { method: string; params: any }[] = [];
    private waiters: (() => void)[] = [];

    constructor(private proc: ChildProcess) {
        proc.stdin!.on("error", () => undefined); // EPIPE after exit
        proc.stdout!.on("data", (chunk: Buffer) => {
            this.buffer = Buffer.concat([this.buffer, chunk]);
            this.drain();
        });
    }

    private drain() {
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const m = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString());
            const length = Number(m![1]);
            if (this.buffer.length < headerEnd + 4 + length) return;
            const msg = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
            this.buffer = this.buffer.subarray(headerEnd + 4 + length);
            if (msg.id !== undefined && msg.method) {
                // server -> client request (configuration, registerCapability…)
                const result = msg.method === "workspace/configuration" ? [{ resPath: RES, lint: { enable: true } }] : null;
                this.send({ jsonrpc: "2.0", id: msg.id, result });
            } else if (msg.id !== undefined) {
                this.pending.get(msg.id)?.(msg.result);
            } else {
                this.notifications.push(msg);
                for (const w of this.waiters.splice(0)) w();
            }
        }
    }

    send(msg: unknown) {
        if (this.proc.exitCode !== null || this.proc.stdin!.destroyed) return;
        const body = Buffer.from(JSON.stringify(msg));
        this.proc.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.proc.stdin!.write(body);
    }

    request(method: string, params: unknown): Promise<any> {
        const id = this.nextId++;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.send({ jsonrpc: "2.0", id, method, params });
        });
    }

    notify(method: string, params: unknown) {
        this.send({ jsonrpc: "2.0", method, params });
    }

    async waitFor(pred: (n: { method: string; params: any }) => boolean, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const found = this.notifications.find(pred);
            if (found) return found;
            if (Date.now() > deadline) throw new Error("timeout waiting for notification");
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
                setTimeout(resolve, 200);
            });
        }
    }
}

test("LSP over stdio publishes diagnostics and answers completion", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcls-lsp-"));
    const out = path.join(tmp, "server.js");
    await build({
        entryPoints: [path.join(EXT_ROOT, "server", "src", "server.ts")],
        // mainFields: jsonc-parser's UMD "main" can't be bundled
        bundle: true, platform: "node", format: "cjs", mainFields: ["module", "main"], target: "node20", outfile: out, logLevel: "silent",
    });
    const proc = spawn(process.execPath, [out, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
    const client = new Client(proc);
    try {
        const init = await client.request("initialize", {
            processId: process.pid,
            rootUri: fileToUri(GOODPACK),
            workspaceFolders: [{ uri: fileToUri(GOODPACK), name: "goodpack" }],
            capabilities: { workspace: { configuration: true, workspaceFolders: true } },
            initializationOptions: { resPath: RES, lint: { enable: true } },
        });
        assert.ok(init.capabilities.completionProvider);
        assert.ok(init.capabilities.codeActionProvider);
        client.notify("initialized", {});

        const file = path.join(GOODPACK, "blocks", "virtual_test.json");
        const uri = fileToUri(file);
        client.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: "json", version: 1, text: '{\n    "texture": "does_not_exist"\n}\n' },
        });
        const published = await client.waitFor((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri === uri
            && n.params.diagnostics.length > 0);
        const diag = published.params.diagnostics[0];
        assert.equal(diag.code, "VC0020");
        assert.equal(diag.source, "voxelcore");
        assert.deepEqual(diag.range, { start: { line: 1, character: 15 }, end: { line: 1, character: 31 } });
        assert.match(diag.codeDescription.href, /block-properties\.md/);

        const completion = await client.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 17 } });
        const labels = (Array.isArray(completion) ? completion : completion.items).map((i: { label: string }) => i.label);
        assert.ok(labels.includes("crate"));

        // whole-workspace lint of not-open files reports the skipped `_draft.json`
        await client.waitFor((n) => n.method === "textDocument/publishDiagnostics" && n.params.uri.endsWith("_draft.json"));

        await client.request("shutdown", null);
        client.notify("exit", null);
    } catch (e) {
        throw new Error(String(e) + "\nserver stderr:\n" + stderr + "\nnotifications:\n" + JSON.stringify(client.notifications).slice(0, 2000));
    } finally {
        proc.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
