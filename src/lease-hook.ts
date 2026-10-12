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

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLease, defaultLeaseOptions, DETACHED_TTL_MAX_MS, leaseStatus, releaseHolder, type LeaseOptions } from "./lease.js";
import { formatAdmitted, formatNoSlot } from "./lease-messages.js";
import { shellQuote } from "./shell-quote.js";

/**
 * npm/npx options before the subcommand: `--prefix`, `--workspace`, `-w` and `--package` take a value (which does not start
 * with `-`), any other option stands alone or is `--name=value`. The two alternatives start with different characters or
 * differ in the value's first character, so a failed match cannot backtrack exponentially.
 */
const NODE_OPTIONS = "(?: (?:(?:--prefix|--workspace|-w|--package) (?:'[^']*'|\"[^\"]*\"|[^\\s'\"-]\\S*)|-[\\w-]+(?:=\\S*)?))*";

/** `[word, pattern]`: `word` appears in every command `pattern` matches; the printed shell pre-filter greps for it. */
const DEFAULT_PATTERNS: readonly (readonly [word: string, pattern: string])[] = [
  ["npm", `npm${NODE_OPTIONS} (?:ci|install|i|test|t)`],
  ["npm", `npm${NODE_OPTIONS} run (?:test|build|typecheck|lint|ci)[\\w:-]*`],
  ["npx", `npx${NODE_OPTIONS} (?:vitest|jest|tsc|playwright)`],
  ["vitest", "vitest"],
  ["jest", "jest"],
  ["tsc", "tsc"],
  ["node", "node --test"],
  ["pytest", "pytest"],
  ["uv", "uv run (?:\\S+ )*(?:pytest|mypy)"],
  ["mypy", "mypy"],
  ["python", "python3? -m (?:pytest|mypy)"],
  ["pip", "pip3? install"],
  ["uv", "uv (?:sync|pip install)"],
  ["xcodebuild", "(?:xcrun )?xcodebuild"],
  ["swift", "(?:xcrun )?swift (?:build|test)"],
  ["cargo", "cargo (?:build|test|check|clippy)"],
  ["gradlew", "gradlew"],
  ["go", "go (?:build|test|vet)"],
  ["deno", "deno test"],
  ["make", "make"],
  ["scripts/test", "scripts/test[\\w-]*\\.sh"],
  // Pre-push hooks. The option-value alternatives start with different characters, so a failed match cannot backtrack exponentially.
  ["git", "git(?: -[Cc] (?:'[^']*'|\"[^\"]*\"|[^\\s'\"](?:[^\\s'\"]|'[^']*'|\"[^\"]*\")*))* push"],
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
/** Whether a token holds an odd number of `"` or `'` (an apostrophe inside a word, as in `Let's`, is not a quote). */
const oddQuote = (token: string): boolean => token.split('"').length % 2 === 0 || token.replace(/[A-Za-z]'[A-Za-z]/g, "").split("'").length % 2 === 0;

const isRegex = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `command` is heavy: it does not mention this CLI (`cli-lease.js` or `claude-orchestrator-lease`), and a
 * segment of its raw split matches a default or `extraPatterns` pattern. Extras that are not valid regexes are
 * ignored; every pattern is anchored at the command word and followed by an end boundary (not `\w`, `.`, `/` or `-`).
 */
export function isHeavyCommand(command: string, extraPatterns: readonly string[] = []): boolean {
  if (CLI.test(command)) return false;
  const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
  const heavy = new RegExp(`(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w./-])`, "y");
  const parts = command.replace(/\\\n/g, " ").split(SEPARATOR);
  return parts.some((segment, i) => i % 2 === 0 && isHeavySegment(segment, heavy, parts[i - 1]));
}

/**
 * Strips the segment's leading words one whitespace token at a time, then tests the command word and the rest. A
 * command word that fails is stripped too when it looks like the tail of a word split at a separator inside it: glued
 * to the `)`, `}` or backtick before the segment (`PYTHONPATH=$(pwd)/src pytest`), or holding an odd number of a quote
 * character (`FOO="a;b" npm test`). The heuristic can also make prose heavy (`"fix(ci): make …"`), which costs only a
 * wait. A tail of more than one word (`MSG="a $(date) b c" npm test`) is skipped by scanning once to the token that closes it.
 */
function isHeavySegment(segment: string, heavy: RegExp, after = ""): boolean {
  const follows = /[)}`]/.test(after);
  // A tail that is only punctuation (`): make …`, `), make …`) is prose, not the rest of a word.
  const glued = follows && /^\S/.test(segment) && !/^[,.;:!?]+\s/.test(segment);
  const tokens = segment.split(/\s+/);
  const word = (i: number): string => tokens[i]?.replace(/^['"]+/, "") ?? "";
  let stripped = false;
  let scanned = false;
  for (let i = 0; i < tokens.length; i++) {
    const w = word(i);
    if (!w) continue;
    const assignment = /^[A-Za-z_]\w*=(['"]?)/.exec(w);
    if (assignment) {
      const quote = assignment[1]!;
      // A quoted value runs to the token that closes it (`FOO='a b'`).
      if (quote && !w.includes(quote, assignment[0].length)) while (++i < tokens.length && !tokens[i]!.includes(quote));
      continue;
    }
    if (PREFIX_WORDS.has(w)) continue;
    const wrapper = WRAPPERS.get(w);
    if (wrapper) {
      let j = i + 1;
      while (word(j).startsWith("-")) j += wrapper.test(word(j)) ? 2 : 1;
      i = w === "timeout" ? j : j - 1; // `timeout` also takes a duration
      continue;
    }
    const name = w.replace(/['"]/g, "");
    if (/^(?:ba|z)?sh$/.test(name.slice(name.lastIndexOf("/") + 1))) {
      // Option tokens up to the flag that ends in `c`; `-o` and `-euo` take an argument (`-o pipefail`).
      let j = i + 1;
      while (word(j).startsWith("-") && !/^-[a-z]*c$/.test(word(j))) j += /^-[a-z]*o$/.test(word(j)) ? 2 : 1;
      if (/^-[a-z]*c$/.test(word(j))) {
        i = j;
        continue;
      }
    }
    // A token that is wholly quoted (`npm "test"`) is tested without its quotes.
    const text = [name, ...tokens.slice(i + 1).map((t) => t.replace(/^(["'])(\S*)\1$/, "$2"))].join(" ");
    // From the command word's start, then after each `/` in it (`./scripts/test.sh`, `.venv/bin/pytest`).
    for (let k = 0; k >= 0; k = name.indexOf("/", k) + 1 || -1) {
      heavy.lastIndex = k;
      if (heavy.test(text)) return true;
    }
    // At most one strip and one scan per segment, so each segment is tested at most three times and the work stays linear.
    if (!stripped && ((i === 0 && glued) || oddQuote(tokens[i]!))) {
      stripped = true;
      continue;
    }
    // A word that still fails (after a strip, or in a segment that follows `)`, `}` or a backtick) may be inside a
    // multi-word value: resume after the first token with an odd quote count, which closes it.
    if (!scanned && (stripped || follows)) {
      scanned = true;
      while (i < tokens.length && !oddQuote(tokens[i]!)) i++;
      continue;
    }
    return false;
  }
  return false;
}

/** `CO_LEASE_PATTERNS_FILE`: a JSON array of extra patterns. A missing or malformed file adds none. */
function extraPatterns(env: NodeJS.ProcessEnv): string[] {
  const file = env.CO_LEASE_PATTERNS_FILE;
  if (!file) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Whether a hook's stdin is a heavy `PreToolUse` `Bash` call with the gate (`CO_LEASE_HOOK=on`) open.
 * Reads only `hook_event_name`, `tool_name` and `tool_input.command`; malformed input is not heavy and never throws.
 */
export function isHeavyHookCall(stdin: string, env: NodeJS.ProcessEnv): boolean {
  if (env.CO_LEASE_HOOK !== "on") return false;
  try {
    const input = JSON.parse(stdin) as { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { command?: unknown } };
    const command = input.tool_input?.command;
    return input.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && typeof command === "string" && isHeavyCommand(command, extraPatterns(env));
  } catch {
    return false;
  }
}

export interface HookIo {
  env: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
  out(text: string): void;
  /** Test seam: merged over the options built from `env` (the clock, sleeper, liveness probe, sampler and `onEvent`). */
  lease?: Partial<LeaseOptions>;
}

const WAIT_MS = 450_000;
const GRACE_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** 10 min: with the 60 s grace, the longest TTL the lease's cap (`DETACHED_TTL_MAX_MS`) lets a writer set. */
const MAX_CALL_TIMEOUT_MS = DETACHED_TTL_MAX_MS - GRACE_MS;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DENY_BACKGROUND = "lease: run heavy commands in the foreground so the lease can track them";

interface HookInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  cwd?: unknown;
  tool_input?: { command?: unknown; timeout?: unknown; run_in_background?: unknown };
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const decision = (fields: Record<string, string>): string => `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } })}\n`;

/**
 * The call's Bash timeout, capped at 10 min so `expiresAt` stays inside the lease's 660 s TTL cap: its own
 * `timeout`, else the session's `BASH_DEFAULT_TIMEOUT_MS`, else 2 min.
 */
function callTimeoutMs(input: HookInput, env: NodeJS.ProcessEnv): number {
  const fromEnv = Number(env.BASH_DEFAULT_TIMEOUT_MS);
  return Math.min(MAX_CALL_TIMEOUT_MS, [input.tool_input?.timeout, fromEnv].find(positive) ?? DEFAULT_CALL_TIMEOUT_MS);
}

/** Dispatches one hook event; `runHook` swallows whatever this throws. */
async function handleEvent(stdin: string, io: HookIo): Promise<void> {
  const { env } = io;
  if (env.CO_LEASE_HOOK !== "on") return;
  const input = JSON.parse(stdin) as HookInput;
  const toolUseId = input.tool_use_id;
  if (input.tool_name !== "Bash" || typeof toolUseId !== "string" || !TOOL_USE_ID.test(toolUseId)) return;
  const event = input.hook_event_name;
  const id = `hook-${toolUseId}`;
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    releaseHolder({ ...defaultLeaseOptions(env, { warn: () => {} }), ...io.lease }, id);
    return;
  }
  if (!isHeavyHookCall(stdin, env)) return;
  const sessionPid = Number(env.CO_LEASE_SESSION_PID);
  if (!Number.isInteger(sessionPid) || sessionPid <= 0) return;
  const opts: LeaseOptions = { ...defaultLeaseOptions(env, { warn: () => {} }), ...io.lease };
  // A hook with no session PID or no usable options stays inert, background calls included. A lease directory that
  // fails only at acquire (unwritable, a symlink) still denies them, while a foreground call there fails open.
  if (input.tool_input?.run_in_background === true) return io.out(decision({ permissionDecision: "deny", permissionDecisionReason: DENY_BACKGROUND }));
  const now = opts.now ?? Date.now;
  const timeoutMs = callTimeoutMs(input, env);
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  // `expiresAt` is a getter so it counts from admission, not from the start of a wait that can last 450 s.
  const detached = { id, sessionPid, get expiresAt() { return now() + timeoutMs + GRACE_MS; } };
  const got = await acquireLease(opts, { command: String(input.tool_input!.command), cwd, detached }, { maxWaitMs: WAIT_MS });
  if (!("leased" in got)) io.out(decision({ permissionDecision: "deny", permissionDecisionReason: formatNoSlot(got, leaseStatus(opts)) }));
  else if (got.leased) io.out(decision({ additionalContext: formatAdmitted(got.admission) }));
}

/** The `hook` subcommand's arguments after `hook`. Always returns 0: hook mode never fails a call. */
export async function runHook(args: string[], io: HookIo): Promise<number> {
  try {
    if (args[0] === "--print-settings-entry") io.out(`${JSON.stringify(settingsEntries(), null, 2)}\n`);
    else await handleEvent(await io.readStdin(), io);
  } catch {
    // Silent by design: a failing hook would show an error on every Bash call.
  }
  return 0;
}

function defaultCliLeasePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cli-lease.js");
}

export interface HookEntry {
  matcher: "Bash";
  hooks: [{ type: "command"; command: string; timeout?: number }];
}

/**
 * The `hooks` settings for the user to install, one `Bash` entry per event. The shell runs the gate and a word
 * pre-filter (bypassed when `CO_LEASE_PATTERNS_FILE` is set) so most calls never start `node`; `$PPID` is read before
 * the pipe because node's parent inside a pipeline is a forked subshell. `cliLeasePath` is this build's own `cli-lease.js`.
 */
export function settingsEntries(cliLeasePath: string = defaultCliLeasePath()): { hooks: Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure", [HookEntry]> } {
  const words = [...new Set(DEFAULT_PATTERNS.map(([word]) => word))].join("|");
  const command =
    `[ "\${CO_LEASE_HOOK:-}" = on ] || exit 0; input=$(cat); ` +
    `[ -n "\${CO_LEASE_PATTERNS_FILE:-}" ] || printf '%s' "$input" | grep -qE ${shellQuote(words)} || exit 0; ` +
    `sp=$PPID; printf '%s' "$input" | CO_LEASE_SESSION_PID=$sp exec node ${shellQuote(cliLeasePath)} hook`;
  // PreToolUse waits for a slot (part 2: up to 450 s); a hook that times out lets the call through unleased.
  const entry = (timeout?: number): [HookEntry] => [{ matcher: "Bash", hooks: [{ type: "command", command, ...(timeout && { timeout }) }] }];
  return { hooks: { PreToolUse: entry(500), PostToolUse: entry(), PostToolUseFailure: entry() } };
}
