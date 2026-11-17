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

import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./lease-dir.js";
import { XCODEBUILD_VALUED } from "./ps.js";
import { acquireLease, defaultLeaseOptions, DETACHED_TTL_MAX_MS, isPid, leaseStatus, releaseHolder, type LeaseOptions } from "./lease.js";
import { BACKGROUNDED_UI_REASON, formatAdmitted, formatRefusal } from "./lease-messages.js";
import { weightFor } from "./lease-weights.js";
import { blankInert, shellCommands } from "./shell-commands.js";
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
const DEFAULT_PATTERNS: readonly (readonly [word: string, pattern: string])[] = [
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

const CLI = /cli-lease\.js|claude-orchestrator-lease|cli-heavy-queue\.js|claude-orchestrator-heavy-queue/;
/** Text that names heavy-queue's `run`; not heavy only while the file at the heavy-queue path is the front-end shim. */
const HEAVY_QUEUE_RUN = /(?:^|[\s/])heavy-queue\s+run(?:\s|$)/;
const shimMarker = "cli-heavy-queue.js";
const defaultHeavyQueuePath = (): string => path.join(homedir(), ".local/share/heavy-queue/heavy-queue");

/** Whether the file at `file` is the sh shim for `cli-heavy-queue.js`; a missing or non-regular file is not. */
function isHeavyQueueShim(file: string): boolean {
  try {
    return readRegularFile(file).includes(shimMarker);
  } catch {
    return false;
  }
}
/** Text that names this CLI, or `heavy-queue run` while the shim is installed: the command takes its own slot, so the hook takes none. */
const leasesItself = (command: string, heavyQueueShim: () => boolean): boolean => CLI.test(command) || (HEAVY_QUEUE_RUN.test(command) && heavyQueueShim());

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
const oddQuote = (token: string): boolean =>
  token.split('"').length % 2 === 0 || token.replace(/[A-Za-z]'(?:[stdm]|re|ve|ll)(?![A-Za-z])/gi, "").split("'").length % 2 === 0;

const isRegex = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether `command` is heavy: it does not mention this CLI (`cli-lease.js`, `claude-orchestrator-lease` or the
 * heavy-queue front end's names), nor `heavy-queue run` while `heavyQueueShim()` says the shim is installed, and a
 * segment of its raw split matches a default or `extraPatterns` pattern. Extras that are not valid regexes are
 * ignored; every pattern is anchored at the command word and followed by an end boundary (not `\w`, `.`, `/` or `-`).
 */
export function isHeavyCommand(command: string, extraPatterns: readonly string[] = [], heavyQueueShim: () => boolean = () => false): boolean {
  if (leasesItself(command, heavyQueueShim)) return false;
  const patterns = [...DEFAULT_PATTERNS.map(([, p]) => p), ...extraPatterns.filter(isRegex)];
  const heavy = new RegExp(`(?:${patterns.map((p) => `(?:${p})`).join("|")})(?![\\w./-])`, "y");
  return anySegmentMatches(command, heavy);
}

/** Whether a segment of the command's raw split, after its leading words, begins with a match of the sticky `pattern`: the one command-position rule of the heavy matcher and the UI-test class. */
function anySegmentMatches(command: string, pattern: RegExp): boolean {
  const parts = command.replace(/\\\n/g, " ").split(SEPARATOR);
  return parts.some((segment, i) => i % 2 === 0 && isHeavySegment(segment, pattern, parts[i - 1]));
}

/** A UI-test action of the build tool: its name (through `xcrun` or a path), any words, then the `test` or `test-without-building` action as a word of its own. */
const UI_TEST = /(?:(?:coproc (?:\w+ )?)?(?:xcrun (?:-{1,2}(?:sdk|toolchain)(?:=\S+| \S+) )*)?xcodebuild(?: \S+)* (?:test|test-without-building))(?![\w./-])/y;

/** The raw-split rule alone: no quote, heredoc or comment tracking, so text that only mentions the action after a separator still matches. `isUiTestCommand` falls back to it for text it cannot tokenize. */
export const isUiTestCommandUntokenized = (command: string): boolean => anySegmentMatches(command, UI_TEST);

/**
 * Whether `command` runs a UI-test action: the build tool, with the `test` or `test-without-building` word, as a command. The text is
 * tokenized (`simpleCommands`: quotes, escapes, comments, heredocs, `$(...)` and backticks, so a heredoc body, a quoted argument or a
 * comment that mentions it is text, and a substitution that runs it is not), and each simple command is read past its leading words
 * (assignments, `nohup`, `time`, `env`, `nice`, `timeout`, `xcrun`, and `sh -c` scripts, recursively). Text it cannot tokenize falls
 * back to `isUiTestCommandUntokenized`, an approximation that over-matches text after a separator and may miss forms the tokenizer reads. It decides the UI-test
 * class only: a miss leaves the command in the heavy class, where it is still leased, and it never makes a command light.
 */
export const isUiTestCommand = (command: string): boolean => uiTestIn(command, 0);

/**
 * Whether `command` runs a UI-test action that is backgrounded: the shell then returns at once, so `PostToolUse` would release the run's slots
 * while it still runs. Decided from the tokenizer: the simple command that runs it, or a pipeline, and-or list, group or subshell holding it, is
 * followed by an `&` separator (a script it runs through `sh -c` or a heredoc is read the same way); an `&` that backgrounds some other command
 * does not count. Text it cannot tokenize falls back to the conservative raw check. Claude Code's own mid-run backgrounding (Ctrl+B) is not seen.
 */
export const uiRunBackgrounded = (command: string): boolean => backgroundedIn(command, 0);

/** `uiRunBackgrounded` for a command whose words are already split (the CLI's `-- argv`): a UI test run by a script it passes to a shell that backgrounds it. */
export function uiArgvBackgrounded(argv: readonly string[]): boolean {
  let inScriptBackgrounded = false;
  const runs = runsUiTest(argv, (script) => ((inScriptBackgrounded = backgroundedIn(script, 1)), uiTestIn(script, 1)));
  return runs && inScriptBackgrounded;
}

/** Whether the text defines a shell function: `name()`, `name ()` or `function name`, with a brace or subshell body (quoted text blanked first). */
const definesFunction = (command: string): boolean => {
  const bare = blankInert(command).replace(/\\./gs, "  ").replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/gs, '""');
  return /(?:^|[\s;&|({])(?:function\s+[\w.:@+-]+|[\w.:@+-]+\s*\(\s*\))/.test(bare);
};

function backgroundedIn(command: string, depth: number): boolean {
  // A backgrounded call of a function may run any body (`f &`, `time f &`, `{ f; } &`, through another function), which the tokenizer does not follow
  // for every form: text that defines a function and has a lone `&` or a `coproc` is decided by the conservative raw check.
  if (depth <= MAX_SCRIPT_DEPTH && definesFunction(command) && rawUiRunBackgrounded(command) && uiTestIn(command, depth)) return true;
  const commands = depth > MAX_SCRIPT_DEPTH ? undefined : shellCommands(command);
  if (commands === undefined) return isUiTestCommandUntokenized(command) && rawUiRunBackgrounded(command);
  return commands.some((c) => {
    let inScriptBackgrounded = false;
    const runs = runsUiTest(c.words, (script) => ((inScriptBackgrounded = backgroundedIn(script, depth + 1)), uiTestIn(script, depth + 1)), c.stdin);
    return runs && (c.background === true || inScriptBackgrounded);
  });
}

function uiTestIn(command: string, depth: number): boolean {
  const commands = depth > MAX_SCRIPT_DEPTH ? undefined : shellCommands(command);
  return commands === undefined ? isUiTestCommandUntokenized(command) : commands.some((c) => runsUiTest(c.words, (script) => uiTestIn(script, depth + 1), c.stdin));
}

const MAX_SCRIPT_DEPTH = 8;

/**
 * Wrappers the UI classifier looks through, by basename (`/usr/bin/time`, `/usr/sbin/taskpolicy`), each with its options that take a value
 * (`man taskpolicy`, `caffeinate`, `arch`, `time`, `env`, `nice`, `timeout`); every other option is a flag. The heavy matcher has its own, smaller table (#327).
 */
const UI_WRAPPERS = new Map<string, RegExp>([
  ["time", /^(?:-[of]|--output|--format)$/],
  ["env", /^(?:-[uCSP]|--unset|--chdir|--split-string)$/],
  ["nice", /^(?:-n|--adjustment)$/],
  ["timeout", /^(?:-[ks]|--kill-after|--signal)$/],
  ["gtimeout", /^(?:-[ks]|--kill-after|--signal)$/],
  ["stdbuf", /^(?:-[ioe]|--input|--output|--error)$/],
  ["taskpolicy", /^-[dgcmjPStlp]$/],
  ["caffeinate", /^-[tw]$/],
  ["arch", /^-(?:arch|d|e)$/],
  ["sudo", /^(?:-[CDghprRtTUu]|--close-from|--chdir|--group|--host|--prompt|--role|--chroot|--type|--command-timeout|--other-user|--user)$/],
  ["script", /^-[tT]$/],
  ["noglob", /^$/],
]);
/** Wrappers that take positional operands before the command: `timeout` and `gtimeout` a duration, `script` the typescript file. */
const WRAPPER_OPERANDS = new Map([["timeout", 1], ["gtimeout", 1], ["script", 1]]);
const XCRUN_VALUED = /^-{1,2}(?:sdk|toolchain)$/;

/**
 * Whether one simple command, given as its words, runs a UI-test action: past its leading words (assignments, `nohup`, `exec`, `command`,
 * `time`, `env`, `nice`, `timeout`, `xcrun` and its sdk options), the command word's basename is `xcodebuild` and an argument that is not an
 * option's value is `test` or `test-without-building`. A `sh -c` script goes to `inScript`. A caller that already has the words (the
 * CLI's argv) uses it directly, so quoting is never lost to a join.
 */
export function runsUiTest(words: readonly string[], inScript: (script: string) => boolean, stdin?: string): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^[A-Za-z_]\w*=/.test(w) || PREFIX_WORDS.has(w) || w === "{" || w === "}") continue;
    // `function NAME {`: the body that follows is the command.
    if (w === "function") {
      const open = words.indexOf("{", i);
      if (open < 0) return false;
      i = open;
      continue;
    }
    // `coproc [NAME] command`: the command, with or without a name, runs as a coprocess.
    if (w === "coproc") return runsUiTest(words.slice(i + 1), inScript, stdin) || runsUiTest(words.slice(i + 2), inScript, stdin);
    const name = path.basename(w);
    const wrapper = UI_WRAPPERS.get(name);
    if (wrapper) {
      let j = i + 1;
      while (words[j]?.startsWith("-")) j += wrapper.test(words[j]!) ? 2 : 1;
      i = j - 1 + (WRAPPER_OPERANDS.get(name) ?? 0);
      continue;
    }
    if (/^(?:ba|z)?sh$/.test(name)) {
      // A here-string (`<<< text`) is the shell's stdin like a heredoc; the words before it are the shell's own.
      const k = words.findIndex((x, idx) => idx > i && x.startsWith("<<<"));
      const end = k < 0 ? words.length : k;
      const input = k < 0 ? stdin : words[k]!.length > 3 ? words[k]!.slice(3) : words[k + 1];
      let j = i + 1;
      let readsStdin = false;
      while (j < end && words[j]!.startsWith("-") && !/^-[a-z]*c$/.test(words[j]!)) {
        if (/^-[a-z]*s[a-z]*$/.test(words[j]!)) readsStdin = true;
        j += /^-[a-z]*o$/.test(words[j]!) ? 2 : 1;
      }
      if (j < end && /^-[a-z]*c$/.test(words[j]!)) return inScript(words[words[j + 1] === "--" ? j + 2 : j + 1] ?? "");
      // No script operand (or `-s`): the shell reads its script from stdin, so a heredoc or here-string fed to it is run.
      return (readsStdin || j >= end) && input !== undefined && inScript(input);
    }
    if (name === "xcrun") {
      while (words[i + 1]?.startsWith("-")) i += XCRUN_VALUED.test(words[i + 1]!) ? 2 : 1;
      continue;
    }
    if (name !== "xcodebuild") return false;
    for (let k = i + 1; k < words.length; k++) {
      if (XCODEBUILD_VALUED.test(words[k]!)) k++;
      else if (words[k] === "test" || words[k] === "test-without-building") return true;
    }
    return false;
  }
  return false;
}

/** `isUiTestCommand` for a command whose words are already split (the CLI's `-- argv`). */
export const isUiTestArgv = (argv: readonly string[]): boolean => runsUiTest(argv, isUiTestCommand);

/**
 * Strips the segment's leading words one whitespace token at a time, then tests the command word and the rest. A
 * command word that fails is stripped too when it looks like the tail of a word split at a separator inside it: glued
 * to the `)`, `}` or backtick before the segment (`PYTHONPATH=$(pwd)/src pytest`), or holding an odd number of a quote
 * character (`FOO="a;b" npm test`). The heuristic can still make some prose heavy, which costs only a wait. In a
 * segment that follows `)`, `}` or a backtick, a tail of more than one word (`MSG="a $(date) b c" npm test`) is skipped
 * by scanning once to the token that closes it; a multi-word value split at `;`, `|`, `&`, a newline, `(` or `{` still
 * hides the command, since the scan runs only after `)`, `}` or a backtick.
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
        i = word(j + 1) === "--" ? j + 1 : j;
        continue;
      }
    }
    // A token that is wholly quoted with no other quote inside (`npm "test"`) is tested without its quotes; `""` and
    // `"O'Brien"` keep theirs, so a pattern that parses quoted values (git's) still sees them.
    const text = [name, ...tokens.slice(i + 1).map((t) => t.replace(/^(["'])([^\s'"]+)\1$/, "$2"))].join(" ");
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
    // In a segment that follows `)`, `}` or a backtick, a word that still fails may be inside a multi-word value: resume
    // after the first token with an odd quote count, which closes it. (Not after an odd-quote strip: a split tail's quote is already closed, and a segment led by a quoted multi-word word, `"a b" pytest`, is a command name the shell reads as one word.)
    if (!scanned && follows) {
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
    const parsed: unknown = JSON.parse(readRegularFile(file));
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Whether a hook's stdin is a heavy `PreToolUse` `Bash` call with the gate (`CO_LEASE_HOOK=on`) open.
 * Reads only `hook_event_name`, `tool_name` and `tool_input.command`; malformed input is not heavy and never throws.
 */
export function isHeavyHookCall(stdin: string, env: NodeJS.ProcessEnv, heavyQueuePath: string = defaultHeavyQueuePath()): boolean {
  if (env.CO_LEASE_HOOK !== "on") return false;
  try {
    const input = JSON.parse(stdin) as HookInput;
    return isHeavyInput(input, env, heavyQueuePath) || isUiTestInput(input, heavyQueuePath);
  } catch {
    return false;
  }
}

/** A `PreToolUse` `Bash` call whose command is a UI-test run that does not lease for itself; the gate (`CO_LEASE_HOOK`) is the caller's. */
const isUiTestInput = (input: HookInput, heavyQueuePath: string): boolean => {
  const command = input.tool_input?.command;
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash" || typeof command !== "string") return false;
  // The tokenizer decides when it can: a UI run that is itself an argument of the lease CLI or `heavy-queue run` is not a UI run of its own (its command
  // word is not the build tool) and leases for itself, while a UI run beside a mention of the CLI in another command or a comment is leased. Text it cannot
  // tokenize keeps the whole-text exemption.
  if (shellCommands(command) !== undefined) return isUiTestCommand(command);
  return !leasesItself(command, () => isHeavyQueueShim(heavyQueuePath)) && isUiTestCommand(command);
};

const isHeavyInput = (input: HookInput, env: NodeJS.ProcessEnv, heavyQueuePath: string): boolean => {
  const command = input.tool_input?.command;
  return input.hook_event_name === "PreToolUse" && input.tool_name === "Bash" && typeof command === "string" && isHeavyCommand(command, extraPatterns(env), () => isHeavyQueueShim(heavyQueuePath));
};

export interface HookIo {
  env: NodeJS.ProcessEnv;
  readStdin(): Promise<string>;
  out(text: string): void;
  /** Test seam: merged over the options built from `env` (the clock, sleeper, liveness probe, sampler and `onEvent`). */
  lease?: Partial<LeaseOptions>;
  /** Test seam: where heavy-queue lives (default `~/.local/share/heavy-queue/heavy-queue`). */
  heavyQueuePath?: string;
}

const WAIT_MS = 450_000;
/**
 * A UI-test call's whole wait (both slots), well inside the printed entry's 500 s timeout: a hook that overruns its timeout lets the call through
 * unleased, so the UI-test class, whose point is that nothing runs beside it, answers (with a denial) with this margin to spare.
 */
const UI_WAIT_MS = 400_000;
const GRACE_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/** 10 min: with the 60 s grace, the longest TTL the lease's cap (`DETACHED_TTL_MAX_MS`) lets a writer set. */
const MAX_CALL_TIMEOUT_MS = DETACHED_TTL_MAX_MS - GRACE_MS;
/** Shorter than the lease's holder id bound (160): the `hook-` prefix keeps `hook-<id>` inside it. */
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DENY_BACKGROUNDED_UI = `lease: no slot after 0s: ${BACKGROUNDED_UI_REASON}`;
/**
 * The raw check, for text the tokenizer cannot parse: whether a command line may background work: an unquoted single `&` that is not part of `&&`, `>&`, `<&`, `&>` or `|&`, after quoted text and
 * backslash-escaped characters are blanked. `PostToolUse` fires when the backgrounded shell returns, so its slots would be released while the test
 * still runs; the line is denied instead. Conservative (it does not know which command the `&` follows): it can deny a line whose `&` backgrounds
 * something else. Claude Code's own mid-run backgrounding (Ctrl+B) is not seen at all and can still release the slots early.
 */
function rawUiRunBackgrounded(command: string): boolean {
  const bare = blankInert(command).replace(/\\./gs, "  ").replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/gs, '""');
  // A coprocess and a process substitution run concurrently too, whether or not the text shows where they end.
  return /(?<![&>|<])&(?![&>])/.test(bare) || /\bcoproc\b|[<>]\(/.test(bare);
}
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
  const opts: LeaseOptions = { ...defaultLeaseOptions(env, { warn: () => {} }), ...io.lease };
  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    releaseHolder(opts, id);
    return;
  }
  const heavyQueuePath = io.heavyQueuePath ?? defaultHeavyQueuePath();
  // A UI-test run is leased whether or not the heavy matcher sees it (`xcrun --sdk iphonesimulator xcodebuild test` is not heavy by it).
  const uiTest = isUiTestInput(input, heavyQueuePath);
  if (!uiTest && !isHeavyInput(input, env, heavyQueuePath)) return;
  const sessionPid = Number(env.CO_LEASE_SESSION_PID);
  if (!isPid(sessionPid)) return;
  // A hook with no session PID or no usable options stays inert, background calls included. A lease directory that
  // fails only at acquire (unwritable, a symlink) still denies them, while a foreground call there fails open.
  if (input.tool_input?.run_in_background === true) return io.out(decision({ permissionDecision: "deny", permissionDecisionReason: uiTest ? DENY_BACKGROUNDED_UI : DENY_BACKGROUND }));
  if (uiTest && uiRunBackgrounded(String(input.tool_input!.command))) return io.out(decision({ permissionDecision: "deny", permissionDecisionReason: DENY_BACKGROUNDED_UI }));
  const now = opts.now ?? Date.now;
  const timeoutMs = callTimeoutMs(input, env);
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  // `expiresAt` is a getter so it counts from admission, not from the start of a wait that can last 450 s.
  const detached = { id, sessionPid, get expiresAt() { return now() + timeoutMs + GRACE_MS; } };
  const command = String(input.tool_input!.command);
  const weight = weightFor(command, cwd, env, () => {});
  const got = await acquireLease(opts, { command, cwd, detached, ...(weight !== undefined && { weight }), ...(uiTest && { uiTest: true as const }) }, { maxWaitMs: uiTest ? UI_WAIT_MS : WAIT_MS });
  if (!("leased" in got)) io.out(decision({ permissionDecision: "deny", permissionDecisionReason: formatRefusal(got, leaseStatus(opts, got.class)) }));
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
  const words = [...new Set(DEFAULT_PATTERNS.map(([word]) => word.replaceAll(" ", GAP)))].join("|");
  const cli = shellQuote(cliLeasePath);
  const missing = shellQuote(`claude-orchestrator-lease hook: ${cliLeasePath} is missing; print the settings entries again and install them`);
  const command =
    `[ "\${CO_LEASE_HOOK:-}" = on ] || exit 0; input=$(cat); ` +
    `[ -n "\${CO_LEASE_PATTERNS_FILE:-}" ] || printf '%s' "$input" | grep -qE ${shellQuote(words)} || exit 0; ` +
    `[ -f ${cli} ] || { printf '%s\\n' ${missing} >&2; exit 0; }; ` +
    `sp=$PPID; printf '%s' "$input" | CO_LEASE_SESSION_PID=$sp exec node ${cli} hook`;
  // PreToolUse waits for a slot (part 2: up to 450 s); a hook that times out lets the call through unleased.
  const entry = (timeout?: number): [HookEntry] => [{ matcher: "Bash", hooks: [{ type: "command", command, ...(timeout && { timeout }) }] }];
  return { hooks: { PreToolUse: entry(500), PostToolUse: entry(), PostToolUseFailure: entry() } };
}
