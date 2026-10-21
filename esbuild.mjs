// Bundles the extension host, the language server and the preview webview.
// Usage: node esbuild.mjs [--watch] [--production]
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
    bundle: true,
    sourcemap: !production,
    minify: production,
    logLevel: "info",
};

const targets = [
    {
        ...common,
        entryPoints: ["src/extension.ts"],
        outfile: "dist/extension.js",
        platform: "node",
        format: "cjs",
        target: "node20",
        external: ["vscode"],
    },
    {
        ...common,
        entryPoints: ["server/src/server.ts"],
        outfile: "dist/server.js",
        platform: "node",
        format: "cjs",
        target: "node20",
    },
    {
        ...common,
        entryPoints: ["server/src/cli.ts"],
        outfile: "dist/cli.js",
        platform: "node",
        format: "cjs",
        target: "node20",
        banner: { js: "#!/usr/bin/env node" },
    },
    {
        ...common,
        entryPoints: ["webview/src/main.ts"],
        outfile: "dist/webview.js",
        platform: "browser",
        format: "iife",
        target: "es2022",
    },
];

if (watch) {
    for (const options of targets) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
    }
} else {
    await Promise.all(targets.map((options) => esbuild.build(options)));
}
