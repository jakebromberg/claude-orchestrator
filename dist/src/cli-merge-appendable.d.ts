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
/** Arguments for git merge driver mode. */
export interface MergeDriverArgs {
    mode: "driver";
    base: string;
    current: string;
    incoming: string;
    arrayPath: string;
    keyField: string;
}
/** Arguments for manual/post-conflict resolution mode. */
export interface ResolveArgs {
    mode: "resolve";
    file: string;
    arrayPath: string;
    keyField: string;
    /** Branch to read the base from. Default: `"main"`. */
    baseBranch: string;
}
export type MergeAppendableArgs = MergeDriverArgs | ResolveArgs;
export declare function parseMergeAppendableArgs(argv: string[]): MergeAppendableArgs;
export interface RunMergeDriverDeps {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => void;
}
export declare function runMergeDriver(args: MergeDriverArgs, deps: RunMergeDriverDeps): void;
export interface RunResolveDeps {
    readFile: (p: string) => string;
    writeFile: (p: string, content: string) => void;
    runCommand: (cmd: string) => string;
    cwd: string;
}
export declare function runResolve(args: ResolveArgs, deps: RunResolveDeps): void;
