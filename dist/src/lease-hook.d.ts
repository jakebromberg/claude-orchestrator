/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. Part 1 takes no slot: it decides and exits 0 with no
 * output. The hook never rewrites the command and never fails a call.
 *
 * The matcher is a lexical scan, not a shell parser (no expansion, aliases or functions). One pass splits the text
 * into segments at top-level `&&`, `||`, `;`, `|`, a single `&`, a newline and a subshell `(`; a separator inside
 * `'…'`, `"…"`, `$(…)` or backticks does not split. Each segment's leading words are stripped one token at a time
 * (`NAME=value`, `env`, `timeout <n>`, `nice [-n <n>]`, `then`/`do`/`else`/`time`/`!`/`{`), and the command word is
 * compared with its quotes and path removed. A segment that calls this CLI is skipped; with `--shell` or `--` the
 * rest of the text is the CLI's own argument and is skipped too.
 */
/**
 * Whether any segment of `command` matches a default or `extraPatterns` heavy pattern. Extras that are not valid
 * regexes are ignored; every pattern is followed by an end boundary (not `\w`, `.`, `/` or `-`). A segment that wraps
 * this CLI ends the scan.
 */
export declare function isHeavyCommand(command: string, extraPatterns?: readonly string[]): boolean;
/**
 * Whether a hook's stdin is a heavy `PreToolUse` `Bash` call with the gate (`CO_LEASE_HOOK=on`) open.
 * Reads only `hook_event_name`, `tool_name` and `tool_input.command`; malformed input is not heavy and never throws.
 */
export declare function isHeavyHookCall(stdin: string, env: NodeJS.ProcessEnv): boolean;
export interface HookIo {
    env: NodeJS.ProcessEnv;
    readStdin(): Promise<string>;
    out(text: string): void;
}
/** The `hook` subcommand's arguments after `hook`. Always returns 0: hook mode never fails a call. */
export declare function runHook(args: string[], io: HookIo): Promise<number>;
export interface HookEntry {
    matcher: "Bash";
    hooks: [{
        type: "command";
        command: string;
        timeout?: number;
    }];
}
/**
 * The `hooks` settings for the user to install, one `Bash` entry per event. The shell runs the gate and a word
 * pre-filter (bypassed when `CO_LEASE_PATTERNS_FILE` is set) so most calls never start `node`; `$PPID` is read before
 * the pipe because node's parent inside a pipeline is a forked subshell. `cliLeasePath` is this build's own `cli-lease.js`.
 */
export declare function settingsEntries(cliLeasePath?: string): {
    hooks: Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure", [HookEntry]>;
};
