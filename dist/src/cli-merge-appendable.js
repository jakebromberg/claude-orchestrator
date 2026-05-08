#!/usr/bin/env node
/**
 * CLI command for merging append-style JSON array files such as Drizzle's
 * `_journal.json`.
 *
 * Two modes:
 *
 * **Git merge driver mode** — wired via `.gitattributes`:
 *   ```
 *   npx claude-orchestrator-merge-appendable \
 *     --base %O --current %A --incoming %B \
 *     --array-path entries --key-field idx
 *   ```
 *   Git invokes this automatically during `git merge` / `git rebase`.
 *   The result is written to the file passed as `--current` (git's `%A`).
 *
 * **Manual/post-conflict mode** — invoked by the user after a failed merge:
 *   ```
 *   npx claude-orchestrator-merge-appendable \
 *     --resolve path/to/_journal.json \
 *     --array-path entries --key-field idx \
 *     [--base-branch main]
 *   ```
 *   The base is read from `git show origin/<baseBranch>:<relPath>`.
 *
 * In both modes `--array-path` and `--key-field` may be replaced with
 * `--config <yaml>` + `--path <file-path>` to look up the configuration from
 * an `appendableFiles` entry in the orchestrator YAML config.
 *
 * ## Setting up the git merge driver
 *
 * 1. Add to `.gitattributes`:
 *    ```
 *    path/to/_journal.json merge=orchestrator-appendable
 *    ```
 *
 * 2. Register the driver (once, per repo clone):
 *    ```
 *    git config merge.orchestrator-appendable.driver \
 *      "npx claude-orchestrator-merge-appendable --base %O --current %A --incoming %B --array-path entries --key-field idx"
 *    ```
 *    Or with a YAML config file:
 *    ```
 *    git config merge.orchestrator-appendable.driver \
 *      "npx claude-orchestrator-merge-appendable --base %O --current %A --incoming %B --config .orchestrator/config.yaml --path path/to/_journal.json"
 *    ```
 *
 * Pure helpers (`parseMergeAppendableArgs`, `runMergeDriver`, `runResolve`)
 * are exported for unit testing.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { YamlConfigSchema } from "./yaml-schema.js";
import { resolveYamlPaths } from "./yaml-loader.js";
import { mergeJsonDocuments, resolveConflict } from "./merge-appendable.js";
// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function takeValue(argv, i, flag) {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
        throw new Error(`${flag} requires an argument`);
    }
    return v;
}
function loadAppendableConfig(yamlPath, filePath) {
    const raw = fs.readFileSync(yamlPath, "utf-8");
    const parsed = parseYaml(raw);
    const yaml = YamlConfigSchema.parse(parsed);
    resolveYamlPaths(yaml, path.dirname(path.resolve(yamlPath)));
    if (!yaml.appendableFiles || yaml.appendableFiles.length === 0) {
        throw new Error(`No appendableFiles configured in ${yamlPath}`);
    }
    const entry = yaml.appendableFiles.find((f) => f.path === filePath);
    if (!entry) {
        const known = yaml.appendableFiles.map((f) => f.path).join(", ");
        throw new Error(`No appendableFiles entry for path "${filePath}" in ${yamlPath}. Known: ${known}`);
    }
    return { arrayPath: entry.arrayPath, keyField: entry.keyField };
}
export function parseMergeAppendableArgs(argv) {
    let base;
    let current;
    let incoming;
    let resolve;
    let arrayPath;
    let keyField;
    let config;
    let configPath;
    let baseBranch = "main";
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        switch (arg) {
            case "--base": {
                if (base !== undefined)
                    throw new Error("--base given more than once");
                base = takeValue(argv, i, "--base");
                i += 2;
                break;
            }
            case "--current": {
                if (current !== undefined)
                    throw new Error("--current given more than once");
                current = takeValue(argv, i, "--current");
                i += 2;
                break;
            }
            case "--incoming": {
                if (incoming !== undefined)
                    throw new Error("--incoming given more than once");
                incoming = takeValue(argv, i, "--incoming");
                i += 2;
                break;
            }
            case "--resolve": {
                if (resolve !== undefined)
                    throw new Error("--resolve given more than once");
                resolve = takeValue(argv, i, "--resolve");
                i += 2;
                break;
            }
            case "--array-path": {
                if (arrayPath !== undefined)
                    throw new Error("--array-path given more than once");
                arrayPath = takeValue(argv, i, "--array-path");
                i += 2;
                break;
            }
            case "--key-field": {
                if (keyField !== undefined)
                    throw new Error("--key-field given more than once");
                keyField = takeValue(argv, i, "--key-field");
                i += 2;
                break;
            }
            case "--config": {
                if (config !== undefined)
                    throw new Error("--config given more than once");
                config = takeValue(argv, i, "--config");
                i += 2;
                break;
            }
            case "--path": {
                if (configPath !== undefined)
                    throw new Error("--path given more than once");
                configPath = takeValue(argv, i, "--path");
                i += 2;
                break;
            }
            case "--base-branch": {
                baseBranch = takeValue(argv, i, "--base-branch");
                i += 2;
                break;
            }
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    // Resolve --array-path/--key-field from YAML config when --config+--path given
    if (config !== undefined || configPath !== undefined) {
        if (!config)
            throw new Error("--config is required when --path is given");
        if (!configPath)
            throw new Error("--path is required when --config is given");
        const fromConfig = loadAppendableConfig(config, configPath);
        if (arrayPath === undefined)
            arrayPath = fromConfig.arrayPath;
        if (keyField === undefined)
            keyField = fromConfig.keyField;
    }
    if (resolve !== undefined) {
        // Manual mode
        if (!arrayPath)
            throw new Error("--array-path is required (or provide --config + --path)");
        if (!keyField)
            throw new Error("--key-field is required (or provide --config + --path)");
        return { mode: "resolve", file: resolve, arrayPath, keyField, baseBranch };
    }
    // Git driver mode
    if (!base)
        throw new Error("--base is required");
    if (!current)
        throw new Error("--current is required");
    if (!incoming)
        throw new Error("--incoming is required");
    if (!arrayPath)
        throw new Error("--array-path is required (or provide --config + --path)");
    if (!keyField)
        throw new Error("--key-field is required (or provide --config + --path)");
    return { mode: "driver", base, current, incoming, arrayPath, keyField };
}
export function runMergeDriver(args, deps) {
    const base = deps.readFile(args.base);
    const current = deps.readFile(args.current);
    const incoming = deps.readFile(args.incoming);
    const merged = mergeJsonDocuments(base, current, incoming, {
        arrayPath: args.arrayPath,
        keyField: args.keyField,
    });
    deps.writeFile(args.current, merged);
}
export function runResolve(args, deps) {
    const conflictContent = deps.readFile(args.file);
    // Determine the file's path relative to the repo root so we can git-show it.
    const repoRoot = deps
        .runCommand(`git -C ${JSON.stringify(deps.cwd)} rev-parse --show-toplevel`)
        .trim();
    const absFile = path.resolve(args.file);
    const relFile = path.relative(repoRoot, absFile);
    const baseContent = deps.runCommand(`git -C ${JSON.stringify(repoRoot)} show origin/${args.baseBranch}:${JSON.stringify(relFile)}`);
    const resolved = resolveConflict(conflictContent, baseContent, {
        arrayPath: args.arrayPath,
        keyField: args.keyField,
    });
    deps.writeFile(args.file, resolved);
}
// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function main() {
    const args = parseMergeAppendableArgs(process.argv.slice(2));
    if (args.mode === "driver") {
        runMergeDriver(args, {
            readFile: (p) => fs.readFileSync(p, "utf-8"),
            writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
        });
    }
    else {
        runResolve(args, {
            readFile: (p) => fs.readFileSync(p, "utf-8"),
            writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
            runCommand: (cmd) => execSync(cmd, { encoding: "utf-8" }),
            cwd: process.cwd(),
        });
    }
}
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = fileURLToPath(import.meta.url);
if (entryPath === thisFile) {
    try {
        main();
    }
    catch (err) {
        process.stderr.write(`merge-appendable failed: ${err.message}\n`);
        process.exit(1);
    }
}
//# sourceMappingURL=cli-merge-appendable.js.map