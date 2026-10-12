/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. Part 1 takes no slot: it decides and exits 0 with no
 * output. The hook never rewrites the command and never fails a call.
 *
 * The matcher is a regex over raw text with no shell parsing: a pattern is
 * tried at the start of the command and after `&&`, `||`, `;`, `|` or a
 * newline, past an optional prefix (`NAME=value`, `env`, `timeout <n>`, `nice`,
 * a path). A segment that calls this CLI is skipped; with `--shell` or `--` the
 * rest of the text is the CLI's own argument and is skipped too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./shell-quote.js";
/** `[word, pattern]`: `word` appears in every command `pattern` matches; the printed shell pre-filter greps for it. */
const DEFAULT_PATTERNS = [
    ["npm", "npm (?:ci|install|i|test|t)"],
    ["npm", "npm run (?:test|build|typecheck|lint|ci)[\\w:-]*"],
    ["npx", "npx (?:vitest|jest|tsc|playwright)"],
    ["vitest", "vitest"],
    ["jest", "jest"],
    ["tsc", "tsc"],
    ["node", "node --test"],
    ["pytest", "pytest"],
    ["uv", "uv run (?:\\S+ )*(?:pytest|mypy)"],
    ["mypy", "mypy"],
    ["uv", "uv (?:sync|pip install)"],
    ["xcodebuild", "xcodebuild"],
    ["swift", "(?:xcrun )?swift (?:build|test)"],
    ["cargo", "cargo (?:build|test)"],
    ["gradlew", "gradlew"],
    ["go", "go (?:build|test|vet)"],
    ["deno", "deno test"],
    ["make", "make"],
    ["scripts/test", "scripts/test[\\w-]*\\.sh"],
    ["git", "git push"], // pre-push hooks
];
const SEGMENT_START = "(?:^|&&|\\|\\||;|\\||\\n)\\s*";
const ARG = "(?:\"[^\"]*\"|'[^']*'|\\S+)";
const PREFIX = `(?:[A-Za-z_]\\w*=(?:"[^"]*"|'[^']*'|\\S*)\\s+|env\\s+|timeout\\s+\\d+[smhd]?\\s+|nice\\s+)*(?:\\S*/)?`;
const CLI = "(?:node\\s+(?:\"(?:[^\"]*/)?cli-lease\\.js\"|'(?:[^']*/)?cli-lease\\.js'|(?:\\S*/)?cli-lease\\.js)|(?:\\S*/)?claude-orchestrator-lease)";
const WRAPPING_CLI = new RegExp(`${SEGMENT_START}${PREFIX}${CLI}(?:\\s+--(?:max-wait|label)\\s+${ARG})*\\s+--(?:shell)?(?=\\s|$)`);
const isRegex = (source) => {
    try {
        new RegExp(source);
        return true;
    }
    catch {
        return false;
    }
};
/** Whether any segment of `command` matches a default or `extraPatterns` heavy pattern. Extras that are not valid regexes are ignored. */
export function isHeavyCommand(command, extraPatterns = []) {
    const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
    const heavy = new RegExp(`${SEGMENT_START}${PREFIX}(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w-])`);
    const wrapped = WRAPPING_CLI.exec(command);
    return heavy.test(wrapped ? command.slice(0, wrapped.index) : command);
}
/** `CO_LEASE_PATTERNS_FILE`: a JSON array of extra patterns. A missing or malformed file adds none. */
function extraPatterns(env) {
    const file = env.CO_LEASE_PATTERNS_FILE;
    if (!file)
        return [];
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
    }
    catch {
        return [];
    }
}
/**
 * Whether a hook's stdin is a heavy `PreToolUse` `Bash` call with the gate (`CO_LEASE_HOOK=on`) open.
 * Reads only `hook_event_name`, `tool_name` and `tool_input.command`; malformed input is not heavy and never throws.
 */
export function isHeavyHookCall(stdin, env) {
    if (env.CO_LEASE_HOOK !== "on")
        return false;
    try {
        const input = JSON.parse(stdin);
        const command = input.tool_input?.command;
        return input.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && typeof command === "string" && isHeavyCommand(command, extraPatterns(env));
    }
    catch {
        return false;
    }
}
/** The `hook` subcommand's arguments after `hook`. Always returns 0: hook mode never fails a call. */
export async function runHook(args, io) {
    try {
        if (args[0] === "--print-settings-entry")
            io.out(`${JSON.stringify(settingsEntries(), null, 2)}\n`);
        else
            isHeavyHookCall(await io.readStdin(), io.env); // part 2 (#123) takes a slot here when this is true
    }
    catch {
        // Silent by design: a failing hook would show an error on every Bash call.
    }
    return 0;
}
function defaultCliLeasePath() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli-lease.js");
}
/**
 * The `hooks` settings for the user to install, one `Bash` entry per event. The shell runs the gate and a word
 * pre-filter (bypassed when `CO_LEASE_PATTERNS_FILE` is set) so most calls never start `node`; `$PPID` is read before
 * the pipe because node's parent inside a pipeline is a forked subshell. `cliLeasePath` is this build's own `cli-lease.js`.
 */
export function settingsEntries(cliLeasePath = defaultCliLeasePath()) {
    const words = [...new Set(DEFAULT_PATTERNS.map(([word]) => word))].join("|");
    const command = `[ "\${CO_LEASE_HOOK:-}" = on ] || exit 0; input=$(cat); ` +
        `[ -n "\${CO_LEASE_PATTERNS_FILE:-}" ] || printf '%s' "$input" | grep -qE ${shellQuote(words)} || exit 0; ` +
        `sp=$PPID; printf '%s' "$input" | CO_LEASE_SESSION_PID=$sp exec node ${shellQuote(cliLeasePath)} hook`;
    // PreToolUse waits for a slot (part 2: up to 450 s); a hook that times out lets the call through unleased.
    const entry = (timeout) => [{ matcher: "Bash", hooks: [{ type: "command", command, ...(timeout && { timeout }) }] }];
    return { hooks: { PreToolUse: entry(500), PostToolUse: entry(), PostToolUseFailure: entry() } };
}
//# sourceMappingURL=lease-hook.js.map