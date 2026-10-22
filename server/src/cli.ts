// vcls CLI: `node dist/cli.js lint <packDir...> [--res <resPath>] [--format text|json]`

import * as fs from "node:fs";
import * as path from "node:path";
import { ContentIndex, isInside } from "../../shared/content/index";
import { collectMentions, createEnv, lintPack, lintProjectFiles } from "./linter";
import { RULES, ruleHref } from "./rules/registry";
import { VcDiagnostic, offsetToLineCol } from "./rules/report";

interface CliResult {
    exitCode: number;
    output: string;
}

const USAGE = `usage: vcls lint <packDir|projectDir...> [--res <resPath>] [--format text|json] [--no-hints]
       vcls rules`;

export function runCli(argv: string[]): CliResult {
    const [command, ...rest] = argv;
    if (command === "rules") {
        const lines = [...RULES.values()].map((r) => `${r.id}  ${r.severity.padEnd(11)} ${r.title}  (${ruleHref(r.id)})`);
        return { exitCode: 0, output: lines.join("\n") + "\n" };
    }
    if (command !== "lint") return { exitCode: 2, output: USAGE + "\n" };
    const packDirs: string[] = [];
    let resPath: string | undefined;
    let format = "text";
    let hints = true;
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === "--res") resPath = rest[++i];
        else if (arg === "--format") format = rest[++i] ?? "text";
        else if (arg === "--no-hints") hints = false;
        else if (arg.startsWith("--")) return { exitCode: 2, output: `unknown option ${arg}\n${USAGE}\n` };
        else packDirs.push(path.resolve(arg));
    }
    if (!packDirs.length) return { exitCode: 2, output: USAGE + "\n" };
    // a project folder lints its project files and the packs in its content/
    const projectDirs = packDirs.filter((d) => fs.existsSync(path.join(d, "project.toml")));
    for (const dir of packDirs) {
        if (!projectDirs.includes(dir) && !fs.existsSync(path.join(dir, "package.json"))) {
            return { exitCode: 2, output: `${dir}: not a content pack or project (no package.json or project.toml)\n` };
        }
    }
    const index = new ContentIndex({ resPath, packDirs: packDirs.filter((d) => !projectDirs.includes(d)), roots: projectDirs });
    const env = createEnv(index, { unknownKeys: true }, false);
    const mentions = collectMentions(index);
    const diagnostics: VcDiagnostic[] = [];
    for (const pack of [...index.packs.values(), ...index.shadowed]) {
        const listed = packDirs.some((d) => isInside(pack.root, d) && isInside(d, pack.root));
        const inProject = projectDirs.some((d) => isInside(pack.root, path.join(d, "content")));
        if (!listed && !inProject) continue;
        for (const list of lintPack(env, pack, undefined, mentions).values()) diagnostics.push(...list);
    }
    for (const project of index.lintableProjects()) {
        for (const list of lintProjectFiles(env, project).values()) diagnostics.push(...list);
    }
    const shown = diagnostics.filter((d) => hints || d.severity !== "hint");
    shown.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
    const texts = new Map<string, string>();
    const textOf = (file: string) => {
        if (!texts.has(file)) {
            let t = "";
            try {
                t = fs.readFileSync(file, "utf8");
            } catch {
                // binary / missing
            }
            texts.set(file, t);
        }
        return texts.get(file)!;
    };
    const records = shown.map((d) => {
        const pos = /\.(png|ogg|wav|vec3)$/i.test(d.file) ? { line: 0, character: 0 } : offsetToLineCol(textOf(d.file), d.start);
        return { ...d, line: pos.line + 1, column: pos.character + 1, href: ruleHref(d.code) };
    });
    const errors = shown.filter((d) => d.severity === "error").length;
    let output: string;
    if (format === "json") {
        output = JSON.stringify(records.map(({ file, line, column, severity, code, message, href }) => (
            { file, line, column, severity, code, message, href })), null, 2) + "\n";
    } else {
        const cwd = process.cwd();
        output = records.map((r) => {
            const rel = path.relative(cwd, r.file) || r.file;
            return `${rel}:${r.line}:${r.column}: ${r.severity} ${r.code} ${r.message}`;
        }).join("\n");
        const warnings = shown.filter((d) => d.severity === "warning").length;
        output += (output ? "\n" : "") + `${errors} error(s), ${warnings} warning(s), ${shown.length - errors - warnings} other\n`;
    }
    return { exitCode: errors > 0 ? 1 : 0, output };
}

if (require.main === module) {
    const result = runCli(process.argv.slice(2));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
}
