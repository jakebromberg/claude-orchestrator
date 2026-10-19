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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./lease-dir.js";
import { acquireLease, defaultLeaseOptions, DETACHED_TTL_MAX_MS, isPid, leaseStatus, releaseHolder } from "./lease.js";
import { formatAdmitted, formatRefusal } from "./lease-messages.js";
import { weightFor } from "./lease-weights.js";
import { shellQuote } from "./shell-quote.js";
/**
 * npm/npx options before the subcommand: `--prefix`/`-C`, `--workspace`/`-w` and `--package`/`-p` take a value, and any
 * other option stands alone or is `--name=value`. A valued option can also be read as a lone flag, but a value never
 * starts with `-`, so each token has at most one reading that continues the match, and a failed match stays linear.
 */
const NPM_OPTIONS = "(?: (?:(?:--prefix|-C|--workspace|-w|--package|-p) (?:'[^']*'|\"[^\"]*\"|[^\\s'\"-]\\S*)|-[\\w-]+(?:=\\S*)?))*";
/** Between the words of a pre-filter entry: whitespace as JSON writes it (`\t`, `\n`), or a quote or continuation run. */
const GAP = "([^A-Za-z0-9]|\\\\[tnr])+";
/** What may follow a command word in the hook JSON: the pre-filter's counterpart of the matcher's `(?![\w./-])`. */
const END = "([^A-Za-z0-9_./-]|$)";
/**
 * `[word, pattern]`: `word` is an ERE found in every command `pattern` matches; the printed shell pre-filter greps the hook
 * JSON for it. A space in a word stands for any whitespace or quote run, since JSON writes a tab as `\t` and a continuation as `\\\n`.
 */
const DEFAULT_PATTERNS = [
    ["npm", `npm${NPM_OPTIONS} (?:ci|install|i|test|t)`],
    ["npm", `npm${NPM_OPTIONS} run (?:test|build|typecheck|lint|ci)[\\w:-]*`],
    ["npx", `npx${NPM_OPTIONS} (?:vitest|jest|tsc|playwright)`],
    [`vitest${END}`, "vitest"],
    [`jest${END}`, "jest"],
    [`tsc${END}`, "tsc"],
    [`node --test${END}`, "node --test"],
    [`pytest${END}`, "pytest"],
    ["uv run", "uv run (?:\\S+ )*(?:pytest|mypy)"],
    [`mypy${END}`, "mypy"],
    ["python3? -m (pytest|mypy|pip)", "python3? -m (?:pytest|mypy|pip install)"],
    ["pip3? install", "pip3? install"],
    ["uv (sync|pip)", "uv (?:sync|pip install)"],
    ["xcodebuild", "(?:xcrun )?xcodebuild"],
    ["swift (build|test)", "(?:xcrun )?swift (?:build|test)"],
    ["cargo (build|test|check|clippy)", "cargo (?:build|test|check|clippy)"],
    [`gradlew${END}`, "gradlew"],
    ["go (build|test|vet)", "go (?:build|test|vet)"],
    ["deno test", "deno test"],
    [`make${END}`, "make"],
    ["scripts/test", "scripts/test[\\w-]*\\.sh"],
    [`scripts/ci${END}`, "scripts/ci"],
    // Pre-push hooks. The option-value alternatives start with different characters, so a failed match cannot backtrack exponentially.
    ["git.*push", "git(?: -[Cc] (?:'[^']*'|\"[^\"]*\"|[^\\s'\"](?:[^\\s'\"]|'[^']*'|\"[^\"]*\")*))* push"],
];
const CLI = /cli-lease\.js|claude-orchestrator-lease/;
/**
 * Every separator, captured so each segment knows the one before it; `&&` and `||` leave an empty segment between,
 * and the `&` of a redirect (`2>&1`) only adds a light one.
 */
const SEPARATOR = /([;&|\n()`{}])/;
/** Leading words after which the command still follows. */
const PREFIX_WORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "!", "nohup", "exec", "command"]);
/** Wrappers that skip option tokens before the operand (`timeout` also a duration); the pattern is the options that take a separate argument. */
const WRAPPERS = new Map([["time", /^$/], ["env", /^-[uC]$/], ["nice", /^-n$/], ["timeout", /^-[ks]$/]]);
/**
 * Whether a token holds an odd number of `"` or `'`. An English contraction's apostrophe (`Let's`, `don't`, `we're`) is not a
 * quote, but any other letter-quote-letter is, so a single-quoted value glued to a letter (`'a;b'c`) still counts.
 */
const oddQuote = (token) => token.split('"').length % 2 === 0 || token.replace(/[A-Za-z]'(?:[stdm]|re|ve|ll)(?![A-Za-z])/gi, "").split("'").length % 2 === 0;
const isRegex = (source) => {
    try {
        new RegExp(source);
        return true;
    }
    catch {
        return false;
    }
};
/**
 * Whether `command` is heavy: it does not mention this CLI (`cli-lease.js` or `claude-orchestrator-lease`), and a
 * segment of its raw split matches a default or `extraPatterns` pattern. Extras that are not valid regexes are
 * ignored; every pattern is anchored at the command word and followed by an end boundary (not `\w`, `.`, `/` or `-`).
 */
export function isHeavyCommand(command, extraPatterns = []) {
    if (CLI.test(command))
        return false;
    const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
    const heavy = new RegExp(`(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w./-])`, "y");
    const parts = command.replace(/\\\n/g, " ").split(SEPARATOR);
    return parts.some((segment, i) => i % 2 === 0 && isHeavySegment(segment, heavy, parts[i - 1]));
}
/**
 * Strips the segment's leading words one whitespace token at a time, then tests the command word and the rest. A
 * command word that fails is stripped too when it looks like the tail of a word split at a separator inside it: glued
 * to the `)`, `}` or backtick before the segment (`PYTHONPATH=$(pwd)/src pytest`), or holding an odd number of a quote
 * character (`FOO="a;b" npm test`). The heuristic can still make some prose heavy, which costs only a wait. In a
 * segment that follows `)`, `}` or a backtick, a tail of more than one word (`MSG="a $(date) b c" npm test`) is skipped
 * by scanning once to the token that closes it; a multi-word value split at `;`, `|`, `&`, a newline, `(` or `{` still
 * hides the command, since the scan runs only after `)`, `}` or a backtick.
 */
function isHeavySegment(segment, heavy, after = "") {
    const follows = /[)}`]/.test(after);
    // A tail that is only punctuation (`): make …`, `), make …`) is prose, not the rest of a word.
    const glued = follows && /^\S/.test(segment) && !/^[,.;:!?]+\s/.test(segment);
    const tokens = segment.split(/\s+/);
    const word = (i) => tokens[i]?.replace(/^['"]+/, "") ?? "";
    let stripped = false;
    let scanned = false;
    for (let i = 0; i < tokens.length; i++) {
        const w = word(i);
        if (!w)
            continue;
        const assignment = /^[A-Za-z_]\w*=(['"]?)/.exec(w);
        if (assignment) {
            const quote = assignment[1];
            // A quoted value runs to the token that closes it (`FOO='a b'`).
            if (quote && !w.includes(quote, assignment[0].length))
                while (++i < tokens.length && !tokens[i].includes(quote))
                    ;
            continue;
        }
        if (PREFIX_WORDS.has(w))
            continue;
        const wrapper = WRAPPERS.get(w);
        if (wrapper) {
            let j = i + 1;
            while (word(j).startsWith("-"))
                j += wrapper.test(word(j)) ? 2 : 1;
            i = w === "timeout" ? j : j - 1; // `timeout` also takes a duration
            continue;
        }
        const name = w.replace(/['"]/g, "");
        if (/^(?:ba|z)?sh$/.test(name.slice(name.lastIndexOf("/") + 1))) {
            // Option tokens up to the flag that ends in `c`; `-o` and `-euo` take an argument (`-o pipefail`).
            let j = i + 1;
            while (word(j).startsWith("-") && !/^-[a-z]*c$/.test(word(j)))
                j += /^-[a-z]*o$/.test(word(j)) ? 2 : 1;
            if (/^-[a-z]*c$/.test(word(j))) {
                i = j;
                continue;
            }
        }
        // A token that is wholly quoted with no other quote inside (`npm "test"`) is tested without its quotes; `""` and
        // `"O'Brien"` keep theirs, so a pattern that parses quoted values (git's) still sees them.
        const text = [name, ...tokens.slice(i + 1).map((t) => t.replace(/^(["'])([^\s'"]+)\1$/, "$2"))].join(" ");
        // From the command word's start, then after each `/` in it (`./scripts/test.sh`, `.venv/bin/pytest`).
        for (let k = 0; k >= 0; k = name.indexOf("/", k) + 1 || -1) {
            heavy.lastIndex = k;
            if (heavy.test(text))
                return true;
        }
        // At most one strip and one scan per segment, so each segment is tested at most three times and the work stays linear.
        if (!stripped && ((i === 0 && glued) || oddQuote(tokens[i]))) {
            stripped = true;
            continue;
        }
        // In a segment that follows `)`, `}` or a backtick, a word that still fails may be inside a multi-word value: resume
        // after the first token with an odd quote count, which closes it. (Not after an odd-quote strip: a split tail's quote is already closed, and a segment led by a quoted multi-word word, `"a b" pytest`, is a command name the shell reads as one word.)
        if (!scanned && follows) {
            scanned = true;
            while (i < tokens.length && !oddQuote(tokens[i]))
                i++;
            continue;
        }
        return false;
    }
    return false;
}
/** `CO_LEASE_PATTERNS_FILE`: a JSON array of extra patterns. A missing or malformed file adds none. */
function extraPatterns(env) {
    const file = env.CO_LEASE_PATTERNS_FILE;
    if (!file)
        return [];
    try {
        const parsed = JSON.parse(readRegularFile(file));
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
        return isHeavyInput(JSON.parse(stdin), env);
    }
    catch {
        return false;
    }
}
const isHeavyInput = (input, env) => {
    const command = input.tool_input?.command;
    return input.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && typeof command === "string" && isHeavyCommand(command, extraPatterns(env));
};
const WAIT_MS = 450_000;
const GRACE_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** 10 min: with the 60 s grace, the longest TTL the lease's cap (`DETACHED_TTL_MAX_MS`) lets a writer set. */
const MAX_CALL_TIMEOUT_MS = DETACHED_TTL_MAX_MS - GRACE_MS;
/** Shorter than the lease's holder id bound (160): the `hook-` prefix keeps `hook-<id>` inside it. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DENY_BACKGROUND = "lease: run heavy commands in the foreground so the lease can track them";
const positive = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
const decision = (fields) => `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } })}\n`;
/**
 * The call's Bash timeout, capped at 10 min so `expiresAt` stays inside the lease's 660 s TTL cap: its own
 * `timeout`, else the session's `BASH_DEFAULT_TIMEOUT_MS`, else 2 min.
 */
function callTimeoutMs(input, env) {
    const fromEnv = Number(env.BASH_DEFAULT_TIMEOUT_MS);
    return Math.min(MAX_CALL_TIMEOUT_MS, [input.tool_input?.timeout, fromEnv].find(positive) ?? DEFAULT_CALL_TIMEOUT_MS);
}
/** Dispatches one hook event; `runHook` swallows whatever this throws. */
async function handleEvent(stdin, io) {
    const { env } = io;
    if (env.CO_LEASE_HOOK !== "on")
        return;
    const input = JSON.parse(stdin);
    const toolUseId = input.tool_use_id;
    if (input.tool_name !== "Bash" || typeof toolUseId !== "string" || !TOOL_USE_ID.test(toolUseId))
        return;
    const event = input.hook_event_name;
    const id = `hook-${toolUseId}`;
    const opts = { ...defaultLeaseOptions(env, { warn: () => { } }), ...io.lease };
    if (event === "PostToolUse" || event === "PostToolUseFailure") {
        releaseHolder(opts, id);
        return;
    }
    if (!isHeavyInput(input, env))
        return;
    const sessionPid = Number(env.CO_LEASE_SESSION_PID);
    if (!isPid(sessionPid))
        return;
    // A hook with no session PID or no usable options stays inert, background calls included. A lease directory that
    // fails only at acquire (unwritable, a symlink) still denies them, while a foreground call there fails open.
    if (input.tool_input?.run_in_background === true)
        return io.out(decision({ permissionDecision: "deny", permissionDecisionReason: DENY_BACKGROUND }));
    const now = opts.now ?? Date.now;
    const timeoutMs = callTimeoutMs(input, env);
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    // `expiresAt` is a getter so it counts from admission, not from the start of a wait that can last 450 s.
    const detached = { id, sessionPid, get expiresAt() { return now() + timeoutMs + GRACE_MS; } };
    const command = String(input.tool_input.command);
    const weight = weightFor(command, cwd, env, () => { });
    const got = await acquireLease(opts, { command, cwd, detached, ...(weight !== undefined && { weight }) }, { maxWaitMs: WAIT_MS });
    if (!("leased" in got))
        io.out(decision({ permissionDecision: "deny", permissionDecisionReason: formatRefusal(got, leaseStatus(opts)) }));
    else if (got.leased)
        io.out(decision({ additionalContext: formatAdmitted(got.admission) }));
}
/** The `hook` subcommand's arguments after `hook`. Always returns 0: hook mode never fails a call. */
export async function runHook(args, io) {
    try {
        if (args[0] === "--print-settings-entry")
            io.out(`${JSON.stringify(settingsEntries(), null, 2)}\n`);
        else
            await handleEvent(await io.readStdin(), io);
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
    const words = [...new Set(DEFAULT_PATTERNS.map(([word]) => word.replaceAll(" ", GAP)))].join("|");
    const cli = shellQuote(cliLeasePath);
    const missing = shellQuote(`claude-orchestrator-lease hook: ${cliLeasePath} is missing; print the settings entries again and install them`);
    const command = `[ "\${CO_LEASE_HOOK:-}" = on ] || exit 0; input=$(cat); ` +
        `[ -n "\${CO_LEASE_PATTERNS_FILE:-}" ] || printf '%s' "$input" | grep -qE ${shellQuote(words)} || exit 0; ` +
        `[ -f ${cli} ] || { printf '%s\\n' ${missing} >&2; exit 0; }; ` +
        `sp=$PPID; printf '%s' "$input" | CO_LEASE_SESSION_PID=$sp exec node ${cli} hook`;
    // PreToolUse waits for a slot (part 2: up to 450 s); a hook that times out lets the call through unleased.
    const entry = (timeout) => [{ matcher: "Bash", hooks: [{ type: "command", command, ...(timeout && { timeout }) }] }];
    return { hooks: { PreToolUse: entry(500), PostToolUse: entry(), PostToolUseFailure: entry() } };
}
//# sourceMappingURL=lease-hook.js.map