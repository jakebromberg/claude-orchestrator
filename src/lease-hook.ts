/**
 * Hook mode for `claude-orchestrator-lease`: a Claude Code `PreToolUse` /
 * `PostToolUse` / `PostToolUseFailure` hook on `Bash` that decides whether a
 * command is heavy. Part 1 takes no slot: it decides and exits 0 with no
 * output. The hook never rewrites the command and never fails a call.
 *
 * The matcher is a lexical scan, not a shell parser (no expansion, aliases or functions); it errs toward heavy, except
 * for this CLI. One pass splits the text into segments at top-level `&&`, `||`, `;`, `|`, a single `&`, a newline and
 * a subshell `(`; nothing inside `'…'`, `"…"`, `$(…)`, backticks, a heredoc body or a `#` comment splits, and nothing
 * in a heredoc body or comment opens a quote. Text that ends inside a quote, `$(` or backtick is also rescanned raw
 * (split at every separator). Each segment's leading words are stripped one token at a time (`NAME=value`, `env`,
 * `timeout <n>`, `nice [-n <n>]`, `if`/`elif`/`while`/`until`/`then`/`do`/`else`/`time`/`!`/`{`), and the command word
 * is compared with its quotes and path removed. `$(…)` and backtick bodies and the `sh`/`bash`/`zsh -c` argument are
 * classified the same way, three levels deep. A segment that calls this CLI is skipped; with `--shell` or `--` the
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

const PREFIX_WORD = /^(?:if|elif|while|until|then|do|else|time|!|\{|env|nice|timeout|[A-Za-z_]\w*=.*)$/s;
const SUBSHELL_START = /^(?:\s|if|elif|while|until|then|do|else|time|!|\{)*$/;
const CLI_JS = /(?:^|\/)cli-lease\.js$/;
const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([A-Za-z_]\w*))/y;

/** Index of the newline that ends heredoc `tag`'s delimiter line, for a body that starts after the newline at `i`; else the length. */
function heredocEnd(s: string, i: number, tag: string, dash: boolean): number {
  for (let end = i; i < s.length; i = end) {
    end = s.indexOf("\n", i + 1);
    if (end < 0) end = s.length;
    const line = s.slice(i + 1, end);
    if (line === tag || (dash && line.replace(/^\t+/, "") === tag)) return end;
  }
  return s.length;
}

/**
 * Index of the first character at or after `from` for which `stop` holds, outside quotes, `$(…)`, backticks, escapes,
 * heredoc bodies and `#` comments (`raw` tracks none of them); else the length, or -1 if a quote, `$(` or backtick is
 * still open. Each outermost `$(…)` or backtick body closed on the way is added to `subs`.
 */
function scanTop(s: string, from: number, stop: (i: number) => boolean, subs: string[] = [], raw = false): number {
  const open: string[] = [];
  const heredocs: [tag: string, dash: boolean][] = [];
  let [subAt, subDepth] = [-1, -1];
  const enter = (closer: string, at: number): void => {
    if (subDepth < 0) [subAt, subDepth] = [at, open.length];
    open.push(closer);
  };
  const leave = (at: number): void => {
    open.pop();
    if (open.length === subDepth) subs.push(s.slice(subAt, at)), (subDepth = -1);
  };
  let m: RegExpExecArray | null;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    const top = open[open.length - 1];
    if (!raw && c === "\n" && heredocs.length && top !== '"') {
      for (const [tag, dash] of heredocs.splice(0)) i = heredocEnd(s, i, tag, dash);
      if (i >= s.length) break;
    }
    if (raw) {
      if (stop(i)) return i;
    } else if (c === "\\") i++;
    else if (top === '"' && c === '"') open.pop();
    else if (top !== '"' && c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (top !== '"' && c === '"') open.push('"');
    else if (c === "$" && s[i + 1] === "(") enter(")", i + 2), i++;
    else if (c === "`") top === "`" ? leave(i) : enter("`", i + 1);
    else if (top === ")" && (c === "(" || c === ")")) c === ")" ? leave(i) : enter(")", i + 1);
    else if (top !== '"' && c === "#" && /[\s;&|()]/.test(s[i - 1] ?? " ")) {
      const end = s.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
    } else if (top !== '"' && c === "<" && s[i - 1] !== "<" && ((HEREDOC.lastIndex = i), (m = HEREDOC.exec(s)))) {
      heredocs.push([m[2] ?? m[3] ?? m[4]!, m[1] === "-"]);
      i = HEREDOC.lastIndex - 1;
    } else if (!open.length && stop(i)) return i;
  }
  return open.length ? -1 : s.length;
}

/** Top-level segments with their `$(…)`/backtick bodies, and whether the text ends open; `&&`/`||` split as two, `>&`, `&>`, `2>&1` do not. */
function segments(text: string, raw: boolean): [list: [segment: string, subs: string[]][], unbalanced: boolean] {
  const out: [string, string[]][] = [];
  let start = 0;
  const isSeparator = (i: number): boolean => {
    const c = text[i]!;
    if (c === "&") return !"<>".includes(text[i - 1] ?? "") && text[i + 1] !== ">";
    return ";|\n".includes(c) || (c === "(" && i - start < 24 && SUBSHELL_START.test(text.slice(start, i)));
  };
  for (;;) {
    const subs: string[] = [];
    const end = scanTop(text, start, isSeparator, subs, raw);
    out.push([text.slice(start, end < 0 ? undefined : end), subs]);
    if (end < 0 || end >= text.length) return [out, end < 0];
    start = end + 1;
  }
}

/** `[start, end)` of the first word at or after `p`; quotes, `$(…)` and escapes keep a word whole. */
function word(s: string, p: number): [number, number] {
  while (p < s.length && /\s/.test(s[p]!)) p++;
  const end = scanTop(s, p, (i) => /\s/.test(s[i]!));
  return [p, end < 0 ? s.length : end];
}

/** A shell word with its quotes and escapes removed. */
const unquote = (w: string): string =>
  w.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs, (_m, sq?: string, dq?: string, esc?: string) =>
    sq ?? dq?.replace(/\\(["\\$`])/g, "$1") ?? esc ?? "");

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
 * this CLI with `--shell` or `--` ends the scan.
 */
export function isHeavyCommand(command: string, extraPatterns: readonly string[] = []): boolean {
  const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
  const heavy = new RegExp(`(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w./-])`, "y");
  return isHeavyText(command.replace(/\\\n/g, " "), heavy, 0);
}

/** `isHeavyCommand` on joined text, `depth` substitution or `-c` levels down; unbalanced text is rescanned `raw`. */
function isHeavyText(text: string, heavy: RegExp, depth: number, raw = false): boolean {
  const [list, unbalanced] = segments(text, raw);
  scan: for (const [segment, subs] of list) {
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
        if (flag === "--shell" || flag === "--") break scan;
        if (flag !== "--max-wait" && flag !== "--label") break;
        pos = word(segment, argTo)[1];
      }
      continue;
    }
    const command = name + segment.slice(to);
    for (let k = 0; k >= 0; k = name.indexOf("/", k) + 1 || -1) {
      heavy.lastIndex = k;
      if (heavy.test(command)) return true;
    }
    if (/^(?:ba|z)?sh$/.test(base) && /^-[a-z]*c[a-z]*$/.test(segment.slice(argFrom, argTo))) subs.push(unquote(segment.slice(...word(segment, argTo))));
    if (depth < 3 && subs.some((body) => isHeavyText(body, heavy, depth + 1))) return true;
  }
  return unbalanced && isHeavyText(text, heavy, depth, true);
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
