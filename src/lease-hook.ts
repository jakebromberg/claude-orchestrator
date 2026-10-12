/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. Part 1 takes no slot: it decides and exits 0 with no
 * output. The hook never rewrites the command and never fails a call.
 *
 * The matcher has two rules and errs toward heavy: a miss runs a heavy command unleased, a false match costs only a
 * wait. (1) Text that contains `cli-lease.js` or `claude-orchestrator-lease` anywhere is not heavy, so the hook never
 * takes the slot the CLI then waits for; the trade is that a command which only mentions the CLI runs unleased.
 * (2) Otherwise the text is split raw at `&&`, `||`, `;`, `|`, a single `&`, newlines, `(`, `)`, backticks, `{` and
 * `}`, with no quote, heredoc or comment tracking. A segment is heavy when, after its leading words are stripped,
 * its command word (quotes and path removed) and the rest match an anchored pattern. With the default patterns,
 * everything is linear. It is not a shell parser: no expansion, aliases or functions.
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
  // Pre-push hooks. The option-value alternatives start with different characters, so a failed match cannot backtrack exponentially.
  ["git", "git(?: -[Cc] (?:'[^']*'|\"[^\"]*\"|[^\\s'\"]\\S*))* push"],
];

const CLI = /cli-lease\.js|claude-orchestrator-lease/;
/** Every separator; `&&` and `||` leave an empty segment between, and the `&` of a redirect (`2>&1`) only adds a light one. */
const SEPARATOR = /[;&|\n()`{}]/;
/** Leading words after which the command still follows; `nice` and `timeout` also drop their arguments. */
const PREFIX_WORDS = new Set(["if", "elif", "while", "until", "then", "do", "else", "time", "!", "env", "nice", "timeout"]);

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
  return command.replace(/\\\n/g, " ").split(SEPARATOR).some((segment) => isHeavySegment(segment, heavy));
}

/** Strips the segment's leading words one whitespace token at a time, then tests the command word and the rest. */
function isHeavySegment(segment: string, heavy: RegExp): boolean {
  const tokens = segment.split(/\s+/);
  const word = (i: number): string => tokens[i]?.replace(/^['"]+/, "") ?? "";
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
    if (PREFIX_WORDS.has(w)) {
      if (w === "nice" && word(i + 1) === "-n") i += 2;
      if (w === "timeout") i += word(i + 1) === "-s" ? 3 : 1;
      continue;
    }
    const name = w.replace(/['"]/g, "");
    if (/^(?:ba|z)?sh$/.test(name.slice(name.lastIndexOf("/") + 1)) && /^-[a-z]*c$/.test(word(i + 1))) {
      i++;
      continue;
    }
    const text = [name, ...tokens.slice(i + 1)].join(" ");
    // From the command word's start, then after each `/` in it (`./scripts/test.sh`, `.venv/bin/pytest`).
    for (let k = 0; k >= 0; k = name.indexOf("/", k) + 1 || -1) {
      heavy.lastIndex = k;
      if (heavy.test(text)) return true;
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
