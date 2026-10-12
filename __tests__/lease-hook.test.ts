import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHeavyCommand, isHeavyHookCall, runHook, settingsEntries } from "../src/lease-hook.js";

const CLI = "/opt/co/dist/src/cli-lease.js";
const QUOTED_CLI = '"${CO_HOME:-$HOME/Developer/claude-orchestrator}/dist/src/cli-lease.js"';

const HEAVY = [
  "npm test", "npm ci", "npm install", "npm i", "npm t", "npm run test:unit", "npm run build", "npm run typecheck",
  "CI=1 npm test", "env CI=1 FOO='a b' npm ci", "timeout 600 npm test", "nice npm run lint", "NODE_ENV=test npx vitest run",
  "npx tsc --noEmit", "npx playwright test", "vitest", "jest --ci", "tsc -p .", "node --test", "node --test dist/",
  "pytest -q", "uv run --no-sync pytest -q", "uv run mypy .", ".venv/bin/pytest", "./.venv/bin/pytest", "mypy src", "uv sync", "uv pip install -r r.txt",
  "xcodebuild test -scheme WXYC", "swift build", "xcrun swift test", "cargo build", "./gradlew test", "go vet ./...", "deno test", "make", "make test",
  "scripts/test-all.sh", "./scripts/test.sh", "git push origin HEAD",
  "cd app && npm test", "git add . ; npm ci", "ruff check . || pytest -q", "echo hi | npm test", "echo hi\nnpm test",
  // The CLI's own text is skipped, nothing else.
  `npm ci && node ${CLI} --shell 'npm test'`,
  `node ${CLI} status && npm test`,
  `claude-orchestrator-lease status && npm test`,
  `cat ${CLI}; npm test`,
  `./node_modules/.bin/claude-orchestrator-lease status; make`,
  // Segment starts beyond && || ; | and newline.
  "if x; then npm test; fi", "for f in a; do pytest; done", "if x; then a; else make; fi", "(npm test)", "{ npm test; }", "time npm test", "! npm test",
  "echo a & npm test", "then deno test", "echo hi 2>&1 | npm test",
  // git's global options before push.
  "git -C /path/to/wt push -u origin HEAD", "git -c core.hooksPath=x push", "git -C '/a b' -c k=v push",
  // Pattern words and paths.
  "make test", "make", "scripts/test-all.sh", `cat x \\\n && npm test`,
];

const NOT_HEAVY = [
  "ls -la", "git status", "git pull", "cat package.json", "cat Makefile", "cat tsconfig.json", "echo npm test", 'grep -r "npm test" .',
  "npm run dev", "npm view left-pad", "npm testing", "node server.js", "makefile", "ls scripts/test.sh",
  `node ${CLI} --shell 'npm ci && npm test'`,
  `claude-orchestrator-lease --shell 'npm ci && npm test'`,
  `node ${QUOTED_CLI} --shell 'npm ci && npm test'`,
  `./node_modules/.bin/claude-orchestrator-lease --max-wait 30 --label 'ci run' --shell 'npm ci; npm test'`,
  `CO_X=1 node ${CLI} -- npm test`,
  // Skip rule: continuations, quoted bins, and the prefix and `--` forms (each fails without its part).
  `node "${CLI}" \\\n  --shell 'npm ci && npm test'`,
  `claude-orchestrator-lease --label ci \\\n  --shell 'npm ci && npm test'`,
  `"./node_modules/.bin/claude-orchestrator-lease" --shell 'npm ci && npm test'`,
  `'./node_modules/.bin/claude-orchestrator-lease' --shell 'npm ci && npm test'`,
  `"$CO_HOME/node_modules/.bin/claude-orchestrator-lease" --shell 'npm ci; npm test'`,
  `CO_X=1 node ${CLI} --shell 'a && npm test'`,
  `env CI=1 timeout 60 claude-orchestrator-lease --shell 'a && npm test'`,
  `CO_X=1 node ${CLI} -- sh -c 'a; npm test'`,
  `node ${CLI} -- sh -c 'a; npm test'`,
  // A pattern word as a directory or file name.
  "./make/foo.sh", "tools/jest/run.sh", "vitest.config.ts", "./make/claude-orchestrator-lease status",
  `node ${CLI} status && ls`,
  `ls && node ${CLI} --shell 'npm test'`,
  "",
];

describe("isHeavyCommand", () => {
  it.each(HEAVY)("matches %j", (command) => {
    expect(isHeavyCommand(command)).toBe(true);
  });

  it.each(NOT_HEAVY)("does not match %j", (command) => {
    expect(isHeavyCommand(command)).toBe(false);
  });

  it.each(["a;", "a && "])("classifies 80 KB of %j in linear time", (unit) => {
    const text = unit.repeat(80_000 / unit.length);
    const start = performance.now();
    expect(isHeavyCommand(text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("adds extra patterns after the same prefix, and ignores one that is not a regex", () => {
    expect(isHeavyCommand("bazel test //...")).toBe(false);
    expect(isHeavyCommand("bazel test //...", ["bazel (?:build|test)"])).toBe(true);
    expect(isHeavyCommand("FOO=1 ./bazel build x", ["bazel (?:build|test)"])).toBe(true);
    expect(isHeavyCommand("npm test", ["("])).toBe(true);
    expect(isHeavyCommand("ls", ["("])).toBe(false);
  });
});

describe("isHeavyHookCall", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-hook-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const call = (command: unknown, over: Record<string, unknown> = {}): string =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, session_id: "s", ...over });
  const on = { CO_LEASE_HOOK: "on" };

  it.each<[string, string, NodeJS.ProcessEnv, boolean]>([
    ["a heavy Bash call with the gate on", call("npm test"), on, true],
    ["a light Bash call", call("ls"), on, false],
    ["the gate unset", call("npm test"), {}, false],
    ["the gate off", call("npm test"), { CO_LEASE_HOOK: "off" }, false],
    ["the gate set to something else", call("npm test"), { CO_LEASE_HOOK: "1" }, false],
    ["a non-Bash tool", call("npm test", { tool_name: "Edit" }), on, false],
    ["a PostToolUse event", call("npm test", { hook_event_name: "PostToolUse" }), on, false],
    ["a command that is not a string", call(["npm", "test"]), on, false],
    ["no tool_input", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }), on, false],
    ["JSON null", "null", on, false],
    ["malformed JSON", "{not json", on, false],
    ["empty stdin", "", on, false],
  ])("%s", (_name, stdin, env, expected) => {
    expect(isHeavyHookCall(stdin, env)).toBe(expected);
  });

  it("reads extra patterns from CO_LEASE_PATTERNS_FILE and survives a bad file", () => {
    const file = join(dir, "patterns.json");
    writeFileSync(file, JSON.stringify(["bazel (?:build|test)", 7]));
    expect(isHeavyHookCall(call("bazel test //..."), { ...on, CO_LEASE_PATTERNS_FILE: file })).toBe(true);
    expect(isHeavyHookCall(call("bazel test //..."), on)).toBe(false);
    writeFileSync(file, "{not json");
    expect(isHeavyHookCall(call("npm test"), { ...on, CO_LEASE_PATTERNS_FILE: file })).toBe(true);
    expect(isHeavyHookCall(call("npm test"), { ...on, CO_LEASE_PATTERNS_FILE: join(dir, "missing.json") })).toBe(true);
  });
});

describe("runHook", () => {
  const io = (stdin: () => Promise<string>, env: NodeJS.ProcessEnv = { CO_LEASE_HOOK: "on" }) => {
    const out: string[] = [];
    return { out, io: { env, readStdin: stdin, out: (t: string) => void out.push(t) } };
  };

  it.each<[string, () => Promise<string>]>([
    ["a heavy call", async () => JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } })],
    ["malformed input", async () => "{"],
    ["a stdin that throws", async () => { throw new Error("EIO"); }],
  ])("exits 0 and prints nothing for %s", async (_name, stdin) => {
    const { out, io: deps } = io(stdin);
    expect(await runHook([], deps)).toBe(0);
    expect(out).toEqual([]);
  });

  it("does not read stdin for --print-settings-entry, and prints the entries as JSON", async () => {
    const { out, io: deps } = io(async () => { throw new Error("stdin read"); });
    expect(await runHook(["--print-settings-entry"], deps)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual(settingsEntries());
  });
});

describe("settingsEntries", () => {
  const entries = settingsEntries("/opt/it's here/dist/src/cli-lease.js");
  const commandOf = (event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure"): string => entries.hooks[event][0]!.hooks[0]!.command;

  it("has the three Bash entries, with the long timeout on PreToolUse only", () => {
    expect(Object.keys(entries.hooks)).toEqual(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
    for (const list of Object.values(entries.hooks)) expect(list.map((e) => e.matcher)).toEqual(["Bash"]);
    expect(entries.hooks.PreToolUse[0]!.hooks[0]).toMatchObject({ type: "command", timeout: 500 });
    expect(entries.hooks.PostToolUse[0]!.hooks[0]).not.toHaveProperty("timeout");
    expect(entries.hooks.PostToolUseFailure[0]!.hooks[0]).not.toHaveProperty("timeout");
  });

  it("runs the CLI by its shell-quoted path, after the gate, the pre-filter and the PID capture", () => {
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
      const command = commandOf(event);
      expect(command).toMatch(/^\[ "\$\{CO_LEASE_HOOK:-\}" = on \] \|\| exit 0; input=\$\(cat\); \[ -n "\$\{CO_LEASE_PATTERNS_FILE:-\}" \] \|\| printf '%s' "\$input" \| grep -qE '[^']+' \|\| exit 0; sp=\$PPID; /);
      expect(command).toMatch(/printf '%s' "\$input" \| CO_LEASE_SESSION_PID=\$sp exec node '\/opt\/it'\\''s here\/dist\/src\/cli-lease\.js' hook$/);
    }
  });

  it("filters on words that every heavy example contains", () => {
    const words = /grep -qE '([^']+)'/.exec(commandOf("PreToolUse"))![1]!;
    const prefilter = new RegExp(words);
    for (const command of HEAVY) expect(prefilter.test(command), command).toBe(true);
  });
});
