/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. Part 1 takes no slot: it decides and exits 0 with no
 * output. The hook never rewrites the command and never fails a call.
 *
 * The matcher is a regex over raw text with no shell parsing: a pattern is
 * tried at the start of the command and after `&&`, `||`, `;`, `|`, a single
 * `&`, `(`, a newline, or `then`/`do`/`else`/`time`/`!`/`{`, past an optional prefix (`NAME=value`, `env`, `timeout <n>`, `nice`,
 * a path). A segment that calls this CLI is skipped; with `--shell` or `--` the
 * rest of the text is the CLI's own argument and is skipped too.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./shell-quote.js";

/** `[word, pattern]`: `word` appears in every command `pattern` matches; the printed shell pre-filter greps for it. */
const DEFAULT_PATTERNS: readonly (readonly [word: string, pattern: string])[] = [
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
  ["git", "git(?: -[Cc] (?:'[^']*'|\\S+))* push"], // pre-push hooks
];

const SEPARATORS = /[;|\n(]|(?<![<>])&(?!>)/; // `&&` and `||` split as two; `2>&1` and `&>` do not
const LEADING = "\\s*(?:(?:then|do|else|time|!|\\{)\\s+)*";
const ARG = "(?:\"[^\"]*\"|'[^']*'|\\S+)";
const PREFIX = `(?:[A-Za-z_]\\w*=(?:"[^"]*"|'[^']*'|\\S*)\\s+|env\\s+|timeout\\s+\\d+[smhd]?\\s+|nice\\s+)*(?:\\S*/)?`;
const CLI = "(?:node\\s+(?:\"(?:[^\"]*/)?cli-lease\\.js\"|'(?:[^']*/)?cli-lease\\.js'|(?:\\S*/)?cli-lease\\.js)|claude-orchestrator-lease[\"']?)";
const WRAPPING_CLI = new RegExp(`^${LEADING}${PREFIX}${CLI}(?:\\s+--(?:max-wait|label)\\s+${ARG})*\\s+--(?:shell)?(?=\\s|$)`);

const isRegex = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether any segment of `command` matches a default or `extraPatterns` heavy pattern. Extras that are not valid
 * regexes are ignored; every pattern is followed by an end boundary (not `\w`, `.`, `/` or `-`). The text is split into
 * segments once, so matching is linear; a segment that wraps this CLI ends the scan.
 */
export function isHeavyCommand(command: string, extraPatterns: readonly string[] = []): boolean {
  const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
  const heavy = new RegExp(`^${LEADING}${PREFIX}(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w./-])`);
  for (const segment of command.replace(/\\\n/g, " ").split(SEPARATORS)) {
    if (heavy.test(segment)) return true;
    if (WRAPPING_CLI.test(segment)) return false;
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
}

/** The `hook` subcommand's arguments after `hook`. Always returns 0: hook mode never fails a call. */
export async function runHook(args: string[], io: HookIo): Promise<number> {
  try {
    if (args[0] === "--print-settings-entry") io.out(`${JSON.stringify(settingsEntries(), null, 2)}\n`);
    else isHeavyHookCall(await io.readStdin(), io.env); // part 2 (#123) takes a slot here when this is true
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
