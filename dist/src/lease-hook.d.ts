/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. `PreToolUse` takes a lease slot for a heavy command (waiting up to 450 s) as a detached holder
 * of the Claude Code process (`CO_LEASE_SESSION_PID`) and lets the command run unchanged; the Post events release it
 * by id. The hook never rewrites the command and never fails a call: any error prints nothing and exits 0.
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
import { type LeaseOptions } from "./lease.js";
/**
 * Whether `command` is heavy: it does not mention this CLI (`cli-lease.js`, `claude-orchestrator-lease` or the
 * heavy-queue front end's names), nor `heavy-queue run` while `heavyQueueShim()` says the shim is installed, and a
 * segment of its raw split matches a default or `extraPatterns` pattern. Extras that are not valid regexes are
 * ignored; every pattern is anchored at the command word and followed by an end boundary (not `\w`, `.`, `/` or `-`).
 */
export declare function isHeavyCommand(command: string, extraPatterns?: readonly string[], heavyQueueShim?: () => boolean): boolean;
/** The raw-split rule alone: no quote, heredoc or comment tracking, so text that only mentions the action after a separator still matches. `isUiTestCommand` falls back to it for text it cannot tokenize. */
export declare const isUiTestCommandUntokenized: (command: string) => boolean;
/**
 * Whether `command` runs a UI-test action: the build tool, with the `test` or `test-without-building` word, as a command. The text is
 * tokenized (`simpleCommands`: quotes, escapes, comments, heredocs, `$(...)` and backticks, so a heredoc body, a quoted argument or a
 * comment that mentions it is text, and a substitution that runs it is not), and each simple command is read past its leading words
 * (assignments, `nohup`, `time`, `env`, `nice`, `timeout`, `xcrun`, and `sh -c` scripts, recursively). Text it cannot tokenize falls
 * back to `isUiTestCommandUntokenized`, an approximation that over-matches text after a separator and may miss forms the tokenizer reads. It decides the UI-test
 * class only: a miss leaves the command in the heavy class, where it is still leased, and it never makes a command light.
 */
export declare const isUiTestCommand: (command: string) => boolean;
/**
 * Whether one simple command, given as its words, runs a UI-test action: past its leading words (assignments, `nohup`, `exec`, `command`,
 * `time`, `env`, `nice`, `timeout`, `xcrun` and its sdk options), the command word's basename is `xcodebuild` and an argument that is not an
 * option's value is `test` or `test-without-building`. A `sh -c` script goes to `inScript`. A caller that already has the words (the
 * CLI's argv) uses it directly, so quoting is never lost to a join.
 */
export declare function runsUiTest(words: readonly string[], inScript: (script: string) => boolean): boolean;
/** `isUiTestCommand` for a command whose words are already split (the CLI's `-- argv`). */
export declare const isUiTestArgv: (argv: readonly string[]) => boolean;
/**
 * Whether a hook's stdin is a heavy `PreToolUse` `Bash` call with the gate (`CO_LEASE_HOOK=on`) open.
 * Reads only `hook_event_name`, `tool_name` and `tool_input.command`; malformed input is not heavy and never throws.
 */
export declare function isHeavyHookCall(stdin: string, env: NodeJS.ProcessEnv, heavyQueuePath?: string): boolean;
export interface HookIo {
    env: NodeJS.ProcessEnv;
    readStdin(): Promise<string>;
    out(text: string): void;
    /** Test seam: merged over the options built from `env` (the clock, sleeper, liveness probe, sampler and `onEvent`). */
    lease?: Partial<LeaseOptions>;
    /** Test seam: where heavy-queue lives (default `~/.local/share/heavy-queue/heavy-queue`). */
    heavyQueuePath?: string;
}
/**
 * Whether a UI-test command line may background work: an unquoted single `&` that is not part of `&&`, `>&`, `<&`, `&>` or `|&`, after quoted text and
 * backslash-escaped characters are blanked. `PostToolUse` fires when the backgrounded shell returns, so its slots would be released while the test
 * still runs; the line is denied instead. Conservative (it does not know which command the `&` follows): it can deny a line whose `&` backgrounds
 * something else. Claude Code's own mid-run backgrounding (Ctrl+B) is not seen at all and can still release the slots early.
 */
export declare function uiRunBackgrounded(command: string): boolean;
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
