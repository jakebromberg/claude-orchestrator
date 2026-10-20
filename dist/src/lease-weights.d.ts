/**
 * Memory weights for heavy commands: a rule table (`<lease dir>/weights.json`, or `CO_LEASE_WEIGHTS_FILE`) of
 * `[{ pattern, repo?, gb }]` and one lookup the hook and the CLI share. `pattern` is an unanchored, case-sensitive
 * `RegExp` test over the command; `repo` is a normalized `owner/repo` (compared case-insensitively with the cwd's `origin`
 * remote) or, when absolute, the cwd's git toplevel. The first match wins and `gb` is GiB (`gb * 2**30`, the unit of
 * `hw.memsize`). No match, a bad table or a failed git lookup yields `undefined`, so the lease applies its unmatched weight.
 */
export interface WeightRule {
    pattern: string;
    repo?: string;
    gb: number;
}
/** The cwd's git facts; each throws or returns "" when unknown. Injectable for tests. */
export interface GitLookup {
    toplevel(cwd: string): string;
    origin(cwd: string): string;
}
export declare const realGit: GitLookup;
/** `owner/repo` from an ssh or https remote URL, with or without `.git`; `undefined` for any other shape. */
export declare function normalizeRemote(url: string): string | undefined;
/**
 * The rules of the weights file: a missing file is silent, an unreadable or malformed one or a bad entry gives one warning, and only valid entries are kept.
 * `<lease dir>/weights.json` is read through `readOwnFile`, so one that is a symlink, FIFO, directory or another user's file is unreadable (one warning);
 * an explicit `CO_LEASE_WEIGHTS_FILE` may be a symlink and is read through `readRegularFile`.
 */
export declare function loadWeightTable(env: NodeJS.ProcessEnv, warn: (line: string) => void): WeightRule[];
/** Bytes for the first rule matching `command` (and `cwd`'s repo, when keyed); `undefined` when none does. */
export declare function resolveWeight(command: string, cwd: string, table: WeightRule[], lookup?: GitLookup): number | undefined;
/** `lookup` answering each fact once per directory; a throw is cached as unknown (""). */
export declare function memoizedGit(lookup: GitLookup): GitLookup;
/**
 * The largest weight over `commands` in `cwd` from the table `env` names; `undefined` when none matches. One table read and at most one git call per fact per directory, because each blocks the caller's event loop.
 */
export declare function weightForCommands(commands: string[], cwd: string, env: NodeJS.ProcessEnv, warn: (line: string) => void, lookup?: GitLookup): number | undefined;
/** The weight for a command in `cwd` from the table `env` names; the one call the hook and the CLI make. */
export declare function weightFor(command: string, cwd: string, env: NodeJS.ProcessEnv, warn: (line: string) => void): number | undefined;
