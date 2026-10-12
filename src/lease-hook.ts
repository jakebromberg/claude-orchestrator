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
  ["git", "git(?: -[Cc] (?:'[^']*'|\"[^\"]*\"|\\S+))* push"], // pre-push hooks
];

const PREFIX_WORD = /^(?:then|do|else|time|!|\{|env|nice|timeout|[A-Za-z_]\w*=.*)$/s;
const SUBSHELL_START = /^(?:\s|then|do|else|time|!|\{)*$/;
const CLI_JS = /(?:^|\/)cli-lease\.js$/;

/** Index of the first character at or after `from`, outside quotes, `$(…)`, backticks and escapes, for which `stop` holds; else the length. */
function scanTop(s: string, from: number, stop: (i: number) => boolean): number {
  const open: string[] = [];
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    const top = open[open.length - 1];
    if (c === "\\") i++;
    else if (top === '"' && c === '"') open.pop();
    else if (top !== '"' && c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return s.length;
      i = close;
    } else if (top !== '"' && c === '"') open.push('"');
    else if (c === "$" && s[i + 1] === "(") open.push(")"), i++;
    else if (c === "`") top === "`" ? open.pop() : open.push("`");
    else if (top === ")" && (c === "(" || c === ")")) c === ")" ? open.pop() : open.push(")");
    else if (!open.length && stop(i)) return i;
  }
  return s.length;
}

/** The text split at top-level separators; `&&` and `||` split as two, `>&`, `&>` and `2>&1` do not. */
function segments(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  const isSeparator = (i: number): boolean => {
    const c = text[i]!;
    if (c === "&") return !"<>".includes(text[i - 1] ?? "") && text[i + 1] !== ">";
    return ";|\n".includes(c) || (c === "(" && i - start < 24 && SUBSHELL_START.test(text.slice(start, i)));
  };
  for (;;) {
    const end = scanTop(text, start, isSeparator);
    out.push(text.slice(start, end));
    if (end >= text.length) return out;
    start = end + 1;
  }
}

/** `[start, end)` of the first word at or after `p`; quotes, `$(…)` and escapes keep a word whole. */
function word(s: string, p: number): [number, number] {
  while (p < s.length && /\s/.test(s[p]!)) p++;
  return [p, scanTop(s, p, (i) => /\s/.test(s[i]!))];
}

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
 * regexes are ignored; every pattern is followed by an end boundary (not `\w`, `.`, `/` or `-`). A segment that wraps
 * this CLI ends the scan.
 */
export function isHeavyCommand(command: string, extraPatterns: readonly string[] = []): boolean {
  const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
  const heavy = new RegExp(`(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w./-])`, "y");
  for (const segment of segments(command.replace(/\\\n/g, " "))) {
    let [from, to] = word(segment, 0);
    for (let prev = ""; ; prev = segment.slice(from, to), [from, to] = word(segment, to)) {
      const w = segment.slice(from, to);
      const numeric = (prev === "timeout" || prev === "-n") && /^\d+[smhd]?$/.test(w);
      if (!numeric && !PREFIX_WORD.test(w) && !(prev === "nice" && w === "-n")) break;
    }
    const name = segment.slice(from, to).replace(/["']/g, "");
    const base = name.slice(name.lastIndexOf("/") + 1);
    let [argFrom, argTo] = word(segment, to);
    const isCli = base === "claude-orchestrator-lease" || (base === "node" && CLI_JS.test(segment.slice(argFrom, argTo).replace(/["']/g, "")));
    if (isCli) {
      for (let pos = base === "node" ? argTo : to; ; ) {
        [argFrom, argTo] = word(segment, pos);
        const flag = segment.slice(argFrom, argTo);
        if (flag === "--shell" || flag === "--") return false;
        if (flag !== "--max-wait" && flag !== "--label") break;
        pos = word(segment, argTo)[1];
      }
      continue;
    }
    const text = name + segment.slice(to);
    for (let k = 0; k >= 0; k = name.indexOf("/", k) + 1 || -1) {
      heavy.lastIndex = k;
      if (heavy.test(text)) return true;
    }
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
