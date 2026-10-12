/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. Part 1 takes no slot: it decides and exits 0 with no
 * output. The hook never rewrites the command and never fails a call.
 *
 * The matcher has two rules and errs toward heavy: a miss runs a heavy command unleased, a false match costs only a
 * wait. (1) Text that contains `cli-lease.js` or `claude-orchestrator-lease` anywhere is not heavy, so the hook never
 * takes a slot for a command whose text names the CLI; the trade is that a command which only mentions the CLI runs
 * unleased. A CLI reached indirectly (an `npm test` script that wraps its runner) is not seen.
 * (2) Otherwise the text is split raw at `&&`, `||`, `;`, `|`, a single `&`, newlines, `(`, `)`, backticks, `{` and
 * `}`, with no quote, heredoc or comment tracking. A segment is heavy when, after its leading words are stripped,
 * its command word (quotes and path removed) and the rest match an anchored pattern. With the default patterns,
 * everything is linear. It is not a shell parser: no expansion, aliases or functions.
 */
/**
 * Whether `command` is heavy: it does not mention this CLI (`cli-lease.js` or `claude-orchestrator-lease`), and a
 * segment of its raw split matches a default or `extraPatterns` pattern. Extras that are not valid regexes are
 * ignored; every pattern is anchored at the command word and followed by an end boundary (not `\w`, `.`, `/` or `-`).
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
