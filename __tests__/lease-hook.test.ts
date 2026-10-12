import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leaseStatus, tryAcquireLease, releaseHolder, type LeaseEvent, type LeaseOptions } from "../src/lease.js";
import { isHeavyCommand, isHeavyHookCall, runHook, settingsEntries } from "../src/lease-hook.js";
import { scriptedPressureSampler } from "../src/testing.js";
import { fakeLeaseClock, isolatedLeaseEnv, unwritableLeaseDir, type FakeLeaseClock } from "./helpers/lease.js";

const CLI = "/opt/co/dist/src/cli-lease.js";
const QUOTED_CLI = '"${CO_HOME:-$HOME/Developer/claude-orchestrator}/dist/src/cli-lease.js"';

const HEAVY = [
  "npm test", "npm ci", "npm install", "npm i", "npm t", "npm run test:unit", "npm run build", "npm run typecheck",
  "CI=1 npm test", "env CI=1 FOO='a b' npm ci", "timeout 600 npm test", "nice npm run lint", "NODE_ENV=test npx vitest run",
  "npx tsc --noEmit", "npx playwright test", "vitest", "jest --ci", "tsc -p .", "node --test", "node --test dist/",
  "pytest -q", "uv run --no-sync pytest -q", "uv run mypy .", ".venv/bin/pytest", "./.venv/bin/pytest", "mypy src", "uv sync", "uv pip install -r r.txt",
  "xcodebuild test -scheme WXYC", "swift build", "xcrun swift test", "cargo build", "./gradlew test", "go vet ./...", "deno test", "make", "make test",
  "scripts/test-all.sh", "./scripts/test.sh", "git push origin HEAD",
  "cd app && npm test", "git add . ; npm ci", "ruff check . || pytest -q", "echo hi | npm test", "echo hi\nnpm test", `cat x \\\n && npm test`, "git -C /path/to/wt \\\n  push -u origin HEAD",
  // Every separator starts a segment: & ( ) { } and backticks too.
  "(npm test)", "{ npm test; }", "echo a & npm test", "echo hi 2>&1 | npm test", "npm test 2>&1",
  // Leading words stripped one token at a time.
  "if x; then npm test; fi", "for f in a; do pytest; done", "if x; then a; else make; fi", "time npm test", "! npm test", "then deno test",
  "if npm test; then echo ok; fi", "if ! npm test; then exit 1; fi", "elif make; then :; fi", "while ! make; do sleep 1; done", "until npm test; do :; done",
  "nice -n 10 npm test", "timeout -s KILL 600 npm test", "env CI=1 npm test",
  "bash -c 'npm test'", "bash -c 'npm ci && npm test'", "timeout 600 bash -c 'npm ci && npm test'", 'sh -c "make"', "bash -lc 'npm test'", "/bin/zsh -c make",
  // Quoted assignments, a quoted command word, and git's global options before push.
  "'npm' test", '"./node_modules/.bin/vitest" run', ...[30, 300].map((n) => `${'NAME="x" '.repeat(n)}npm test`),
  "git -C /path/to/wt push -u origin HEAD", "git -c core.hooksPath=x push", "git -C '/a b' -c k=v push", 'git -C "/a b" push', "git -c 'k=a b' push",
  // `$(…)` and backtick bodies are segments of their own.
  "FOO=$(pwd) npm test", 'DATABASE_URL="$(cat .env.test)" npm test', "A=$(echo a b) B='c d' env X=`pwd` npm test",
  `out=$(npm test 2>&1); echo "$out" | tail`, "echo $(npm test)", "x=`make`", "X=`date +%s` npm test",
  // A word split by a separator inside it: its tail, glued to `)`, `}` or a backtick or holding an odd quote, is stripped too.
  "PYTHONPATH=$(pwd)/src pytest -q", 'PYTHONPATH="$(pwd)/src" pytest -q', "PYTHONPATH=${PWD}/src pytest -q", "PYTHONPATH=${PYTHONPATH}:src pytest",
  'PATH="$(pwd)/node_modules/.bin:$PATH" npm test', 'DATABASE_URL="postgres://$(whoami)@localhost/test" npm test', 'MSG="built $(date) ok" npm test',
  'DB="ts_$(basename "$(pwd)")_test" pytest -q', "X=`pwd`/src pytest", 'FOO="a;b" npm test', "LD_LIBRARY_PATH=${HOME}/lib cargo test",
  "env PATH=${HOME}/bin:$PATH npm test", '"$(npm bin)/vitest" run', "FOO='a;b' npm test", "FILTER='unit|smoke' npm test",
  // Quotes, heredocs and comments are not tracked, so an apostrophe in them hides nothing after them.
  `echo 'a && b' && npm test`, `echo "$(ls; pwd)" ; npm test`, `echo "it's\nok && npm test`,
  `git commit -m "$(cat <<'EOF'\nTighten the matcher's scan\n\nIt's "quoted" here\nEOF\n)" && git push -u origin HEAD`,
  `git commit -m "$(cat <<'EOF'\nFix the hook's matcher\nEOF\n)" && git push`,
  "# don't skip\nnpm test", "cat > f <<EOF\nDon't\nEOF\nmake", "ls # it's here\nnpm test",
  "cat > a.txt <<END-OF-FILE\nhello\nEND-OF-FILE\nnpm test", "cat <<E\"O\"F\nit's\nEOF\nnpm test", "x=$(( 1 << n ))\nnpm test",
  "cat <<-EOF\n\tit's\n\tEOF\nnpm test", "sh <<'EOF'\nnpm test\nEOF", "bash -s <<'EOF'\nmake\nEOF",
  // Launcher forms of the default tools, and npm/npx options before the subcommand.
  "python -m pytest", "python3 -m pytest", ".venv/bin/python -m pytest -q", "python -m mypy src", "pip install -r requirements.txt", "./.venv/bin/pip install -q -r requirements-dev.txt",
  "npm --prefix app test", "npm -w packages/a test", "npm --workspace=a run build", "npm --silent --prefix 'my app' ci", "npx --yes vitest run", "npx -y tsc --noEmit", 'npm "test"',
  "xcrun xcodebuild test -scheme X", "cargo check", "cargo clippy",
  // Wrappers and their options.
  "nohup npm test > log 2>&1 &", "exec npm test", "command npm test", "nohup nice -n 5 make",
  "bash -euo pipefail -c 'npm test'", "bash -e -c 'make'", "bash --login -c 'npm test'", "bash -o pipefail -lc 'npm test'",
  "timeout -k 5 600 npm test", "timeout --signal=KILL 600 npm test", "nice -10 npm test", "nice -n10 npm test", "env -u FOO npm test", "time -p npm test",
  "git -c core.sshCommand='ssh -i key' push", 'git -c "core.sshCommand=ssh -i key" -C /a push',
  // A quoted value of several words, split by a separator inside it.
  'GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/id_ed25519 -o IdentitiesOnly=yes" git push origin HEAD', 'NODE_OPTIONS="--require ${PWD}/setup.js --max-old-space-size=4096" npm test',
  'JAVA_OPTS="-Dfoo=${HOME}/x -Xmx2g" ./gradlew test', 'CFLAGS="-I$(brew --prefix)/include -O2" make', 'PYTEST_ADDOPTS="--basetemp=$(mktemp -d) -p no:cacheprovider" pytest',
  'MSG="a $(date) b c" npm test', "A=${B}/x npm test \"it's\"",
  // Heavy words in data: a false match costs only a wait.
  "cat <<'EOF'\nnpm test\nEOF", 'echo "a \\" ; npm test"', "ls # a; npm test",
];

const NOT_HEAVY = [
  "ls", "ls -la", "echo hi", "git status", "git pull", "cat package.json", "cat Makefile", "cat tsconfig.json", "echo npm test", 'grep -r "npm test" .',
  "npm run dev", "npm view left-pad", "npm testing", "node server.js", "makefile", "ls scripts/test.sh", 'echo "$(ls)"', "cat <<'EOF'\nhello\nEOF", "",
  // A pattern word as a directory or file name.
  "./make/foo.sh", "tools/jest/run.sh", "vitest.config.ts",
  // A stripped tail leaves only what follows it.
  "echo $(date)/x", "X=$(pwd)/src ls", 'FOO="a;b" ls', "cd $(pwd) && ls",
  // Only `)`, `}` and a backtick glue a tail: a word after `|` or a newline is a command word.
  "ps aux|grep make", `git commit -m "$(cat <<'EOF'\nBump vitest to 3.2\nEOF\n)"`,
  // Light forms that look like the heavy ones above.
  "echo npm test", "pip list", "pip3 list", "python script.py", "python -m http.server", "cargo fmt", "nohup ls", "exec ls", "command -v npm", "npm --prefix app run dev", "npx -y cowsay hi",
  "bash -euo pipefail script.sh", "bash -e -c 'ls'", "timeout -k 5 600 sleep 1", "nice -10 ls", "env -u FOO ls", "time -p ls", "git -c core.sshCommand='ssh -i key' pull",
  'MSG="a $(date) b c" ls', 'JAVA_OPTS="-Dfoo=${HOME}/x -Xmx2g" ls',
  // Prose that the tail heuristic made heavy: punctuation after `)` and contractions are not tails.
  'git commit -m "fix(ci): make tests deterministic"', 'git commit -m "feat(api): make it fast"', 'git commit -m "Update README (typos), make examples consistent"',
  "cat <<'EOF'\nLet's make it\nEOF", "cat <<'EOF'\nDon't make it\nEOF",
  // The CLI rule: any text that mentions the CLI takes no slot, whatever surrounds it.
  `node ${CLI} --shell 'npm ci && npm test'`,
  `claude-orchestrator-lease --shell 'npm ci && npm test'`,
  `node ${QUOTED_CLI} --shell 'npm ci && npm test'`,
  `node "$(git rev-parse --show-toplevel)/dist/src/cli-lease.js" --shell 'npm ci && npm test'`,
  `"./node_modules/.bin/claude-orchestrator-lease" --shell 'npm ci && npm test'`,
  `./node_modules/.bin/claude-orchestrator-lease --max-wait 30 --label 'ci run' --shell 'npm ci; npm test'`,
  `node "${CLI}" \\\n  --shell 'npm ci && npm test'`,
  `CO_X=1 node ${CLI} -- sh -c 'a; npm test'`,
  `out=$(claude-orchestrator-lease --shell 'npm ci && npm test')`,
  "claude-orchestrator-lease --label 'a; b' -- npm test ; make",
  "cat <<'EOF' | gh pr comment 141 --body-file -\nIt's done\nEOF\nclaude-orchestrator-lease --shell 'npm ci && npm test'",
  "echo $'it\\'s'; claude-orchestrator-lease --label 'lint & test' --shell 'npm ci && npm test'",
  // A command that only mentions the CLI runs unleased: the accepted trade for a rule that cannot deadlock.
  `npm ci && node ${CLI} --shell 'npm test'`,
  `cat ${CLI}; npm test`,
  "claude-orchestrator-lease status && npm test",
];

describe("isHeavyCommand", () => {
  it.each(HEAVY)("matches %j", (command) => {
    expect(isHeavyCommand(command)).toBe(true);
  });

  it.each(NOT_HEAVY)("does not match %j", (command) => {
    expect(isHeavyCommand(command)).toBe(false);
  });

  // `text(kb)` is about `kb` KB of the same adversarial shape.
  const rep = (unit: string, kb: number): string => unit.repeat(Math.ceil((kb * 1000) / unit.length));
  const bestOf = (text: string, runs = 5): number => {
    let best = Infinity;
    for (let n = 0; n < runs; n++) {
      const start = performance.now();
      isHeavyCommand(text);
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it.each<[string, (kb: number) => string, boolean]>([
    ["a;", (kb) => rep("a;", kb), false],
    ["a && ", (kb) => rep("a && ", kb), false],
    ["a(", (kb) => rep("a(", kb), false],
    ["'", (kb) => rep("'", kb), false],
    ["odd-quoted words", (kb) => rep("a' ", kb), false],
    ["odd-quoted words after )", (kb) => `a) ${rep("b' ", kb)}`, false],
    ["unquoted words after )", (kb) => `a) ${rep("b ", kb)}`, false],
    ["glued tails", (kb) => rep("a)b' ", kb), false],
    ["glued tails ending in a heavy command", (kb) => `${rep("a)b' ", kb)}\nnpm test`, true],
    ["a multi-word tail before npm test", (kb) => `X="a $(b) ${rep("c ", kb)}d" npm test`, true],
    ["bash options before -c", (kb) => `bash ${rep("-e ", kb)}-c 'npm test'`, true],
    ["bash options with no -c", (kb) => `bash ${rep("-o pipefail ", kb)}x`, false],
    ["timeout options", (kb) => `timeout ${rep("-k 5 ", kb)}600 npm test`, true],
    ["nice options", (kb) => `nice ${rep("-10 ", kb)}ls`, false],
    ["env options", (kb) => `env ${rep("-u A ", kb)}npm test`, true],
    ["npm valued options", (kb) => `npm ${rep("--prefix a ", kb)}test`, true],
    ["npm valued options with no subcommand", (kb) => `npm ${rep("-w ", kb)}x`, false],
    ["npm quoted options", (kb) => `npm ${rep("-w 'a b' ", kb)}dev`, false],
    ["npm odd-quoted options", (kb) => `npm ${rep("-w ' ", kb)}x`, false],
    ["npx flags", (kb) => `npx ${rep("-y ", kb)}vitest`, true],
    ["quoted tokens after npm", (kb) => `npm ${rep('"a" ', kb)}`, false],
    ["quoted git options", (kb) => `git${rep(" -c 'x'", kb)} pull`, false],
    ["quoted spans in a git option value", (kb) => `git -c a${rep("'x y'b", kb)} push`, true],
  ])("classifies 80 KB of %s in well under a second, and in time that grows linearly", (_name, text, expected) => {
    // A loose absolute budget, so a loaded machine running the whole suite in parallel stays green: the linear
    // matcher takes a few ms here, while the quadratic and exponential versions it replaced take seconds to minutes.
    // The assertions are the guard; the 60 s test timeout is only a backstop, because one row runs the matcher up to 43
    // times and a loaded machine has taken longer than the 5 s default for that.
    const start = performance.now();
    expect(isHeavyCommand(text(80))).toBe(expected);
    expect(performance.now() - start).toBeLessThan(1000);
    // Four times the text takes about four times as long when linear and sixteen times as long when quadratic. A
    // loaded machine can skew one measurement, so the ratio passes if any of three best-of-seven attempts does (the
    // loop stops at the first, so a quiet machine pays for one); a super-linear slowdown fails all of them.
    const [large, small] = [text(80), text(20)];
    let ratio = Infinity;
    for (let attempt = 0; attempt < 3 && ratio >= 8; attempt++) {
      ratio = Math.min(ratio, bestOf(large, 7) / Math.max(bestOf(small, 7), 0.05));
    }
    expect(ratio).toBeLessThan(8);
  }, 60_000);

  it.each([
    ["300 quoted assignments before npm test", `${'NAME="x" '.repeat(300)}npm test`, true],
    ["300 quoted assignments before ls", `${'NAME="x" '.repeat(300)}ls`, false],
    ["28 quoted git options before pull", `git${" -c 'x'".repeat(28)} pull`, false],
    ["28 quoted npm options before dev", `npm${" -w 'x'".repeat(28)} dev`, false],
  ])("classifies %s in well under a second", (_name, text, expected) => {
    const start = performance.now();
    expect(isHeavyCommand(text)).toBe(expected);
    expect(performance.now() - start).toBeLessThan(1000);
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

describe("hook events", () => {
  const SESSION = 7001;
  const DENY_BACKGROUND = "lease: run heavy commands in the foreground so the lease can track them";
  let tmp: string;
  let dir: string;
  let fake: FakeLeaseClock;
  let alive: Set<number>;
  let events: LeaseEvent[];
  let level: "normal" | "warning" | "critical";

  const holderFile = (id: string): string => join(dir, "holders", `${id}.json`);
  const holders = (): string[] => (existsSync(join(dir, "holders")) ? readdirSync(join(dir, "holders")).sort() : []);
  const call = (event: string, over: Record<string, unknown> = {}, input: Record<string, unknown> = {}): string =>
    JSON.stringify({ hook_event_name: event, tool_name: "Bash", tool_use_id: "toolu_1", cwd: "/work", tool_input: { command: "npm test", ...input }, ...over });
  const pre = (input: Record<string, unknown> = {}, over: Record<string, unknown> = {}): string => call("PreToolUse", over, input);

  /** Runs the hook with the real option builder from `env`; only the clock, the sleeper, the liveness probe and the sampler are scripted. */
  const run = async (stdin: string, envOver: NodeJS.ProcessEnv = {}, lease: Partial<LeaseOptions> = {}): Promise<{ code: number; out: string }> => {
    const env = isolatedLeaseEnv(dir, { CO_LEASE_HOOK: "on", CO_LEASE_SESSION_PID: String(SESSION), BASH_DEFAULT_TIMEOUT_MS: undefined, ...envOver });
    let out = "";
    const code = await runHook([], {
      env,
      readStdin: async () => stdin,
      out: (t) => void (out += t),
      lease: Object.fromEntries(
        Object.entries({ level: scriptedPressureSampler(() => level), now: fake.now, sleep: fake.sleep, isAlive: (pid: number) => alive.has(pid), onEvent: (e: LeaseEvent) => void events.push(e), ...lease }).filter(([, v]) => v !== undefined),
      ),
    });
    return { code, out };
  };
  const admitted = (line: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: line } }) + "\n";
  const denied = (reason: string): string =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n";
  const record = (id: string): Record<string, unknown> => JSON.parse(readFileSync(holderFile(id), "utf8")) as Record<string, unknown>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-hook-ev-"));
    dir = join(tmp, "lease");
    fake = fakeLeaseClock();
    alive = new Set([SESSION]);
    events = [];
    level = "normal";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Fills the one slot with a detached holder that outlives a 450 s wait. */
  const fillSlot = (expiresIn = 600_000): void => {
    alive.add(7002);
    tryAcquireLease(
      { dir, level: scriptedPressureSampler("normal"), policy: { heavyCeiling: 1, heavyWarning: 1 }, isAlive: (pid) => alive.has(pid), now: fake.now },
      { command: "npm test", cwd: "/", detached: { id: "hook-other", sessionPid: 7002, expiresAt: fake.ms + expiresIn } },
    );
  };

  describe("PreToolUse", () => {
    it("admits: a detached holder for the session, the admitted line as additionalContext, and no decision", async () => {
      const start = fake.ms;
      const { code, out } = await run(pre());
      expect(code).toBe(0);
      expect(out).toBe(admitted("lease: admitted after 0s (pressure=normal, 1/1 live)"));
      expect(JSON.parse(out).hookSpecificOutput).not.toHaveProperty("permissionDecision");
      expect(JSON.parse(out)).not.toHaveProperty("updatedInput");
      expect(record("hook-toolu_1")).toMatchObject({ id: "hook-toolu_1", pid: SESSION, cwd: "/work", expiresAt: start + 120_000 + 60_000 });
    });

    // [description, tool_input.timeout, BASH_DEFAULT_TIMEOUT_MS, expected call timeout ms]
    it.each<[string, unknown, string | undefined, number]>([
      ["the call's own timeout", 300_000, "90000", 300_000],
      ["BASH_DEFAULT_TIMEOUT_MS when the call has none", undefined, "90000", 90_000],
      ["120 000 when neither is set", undefined, undefined, 120_000],
      ["120 000 when the env value is not a number", undefined, "soon", 120_000],
      ["120 000 when the call's timeout is not a positive number", -5, undefined, 120_000],
      ["the 600 000 cap for a larger timeout", 900_000, undefined, 600_000],
    ])("sets expiresAt from %s plus 60 s", async (_name, timeout, envDefault, expected) => {
      const start = fake.ms;
      await run(pre(timeout === undefined ? {} : { timeout }), { BASH_DEFAULT_TIMEOUT_MS: envDefault });
      expect(record("hook-toolu_1").expiresAt).toBe(start + expected + 60_000);
    });

    it("keeps a holder at the 600 s cap live through a backward clock step of up to 90 s", async () => {
      await run(pre({ timeout: 600_000 }));
      fake.ms -= 90_000;
      const opts = { dir, level: scriptedPressureSampler("normal"), policy: { heavyCeiling: 1, heavyWarning: 1 }, isAlive: (pid: number) => alive.has(pid), now: fake.now };
      expect(leaseStatus(opts).live.map((h) => h.id)).toEqual(["hook-toolu_1"]);
    });

    it("counts expiresAt from admission, so a long wait does not eat the call's time", async () => {
      fillSlot();
      fake.onSleep = () => {
        if (fake.sleeps.length === 3) releaseHolder({ dir, level: scriptedPressureSampler("normal"), policy: { heavyCeiling: 1, heavyWarning: 1 }, now: fake.now }, "hook-other");
      };
      const { out } = await run(pre());
      expect(out).toMatch(/^\{"hookSpecificOutput":\{"hookEventName":"PreToolUse","additionalContext":"lease: admitted after [1-9]\d*s /);
      expect(record("hook-toolu_1").expiresAt).toBe(fake.ms + 180_000);
    });

    it("denies with the exact no-slot line when no slot frees within 450 s", async () => {
      fillSlot();
      const { code, out } = await run(pre());
      expect(code).toBe(0);
      expect(out).toBe(denied("lease: no slot after 450s (pressure=normal, capacity 1, 1 live: 7002 npm test); rerun the command — this is not a test failure"));
      expect(holders()).toEqual(["hook-other.json"]);
      expect(events).toContainEqual({ type: "timeout", refused: "max-wait", waitedMs: 450_000 });
    });

    it("denies at critical, whatever the lease directory", async () => {
      level = "critical";
      const { out } = await run(pre(), { CO_LEASE_DIR: unwritableLeaseDir(tmp) });
      expect(out).toBe(denied("lease: no slot after 450s (pressure=critical, capacity 0, 0 live: none); rerun the command — this is not a test failure"));
    });

    it("denies run_in_background for a heavy command, without taking a slot or waiting", async () => {
      const { out } = await run(pre({ run_in_background: true }));
      expect(out).toBe(denied(DENY_BACKGROUND));
      expect(holders()).toEqual([]);
      expect(fake.sleeps).toEqual([]);
    });

    it("lets a light command run_in_background through silently", async () => {
      expect(await run(pre({ command: "ls", run_in_background: true }))).toEqual({ code: 0, out: "" });
    });

    it.each<[string, string, NodeJS.ProcessEnv]>([
      ["a light command", pre({ command: "ls" }), {}],
      ["the gate off", pre(), { CO_LEASE_HOOK: "" }],
      ["a non-Bash tool", pre({}, { tool_name: "Edit" }), {}],
      ["no session PID", pre(), { CO_LEASE_SESSION_PID: undefined }],
      ["a session PID that is not a PID", pre(), { CO_LEASE_SESSION_PID: "0" }],
      ["malformed input", "{", {}],
    ])("prints nothing and takes no slot for %s", async (_name, stdin, env) => {
      expect(await run(stdin, env)).toEqual({ code: 0, out: "" });
      expect(holders()).toEqual([]);
    });

    it("fails open below critical when the directory is unwritable: no holder, no output", async () => {
      expect(await run(pre(), { CO_LEASE_DIR: unwritableLeaseDir(tmp) })).toEqual({ code: 0, out: "" });
      expect(events).toContainEqual(expect.objectContaining({ type: "fail-open", reason: "io-error" }));
      expect(holders()).toEqual([]);
    });
  });

  describe.each(["PostToolUse", "PostToolUseFailure"])("%s", (event) => {
    it("releases hook-<tool_use_id> silently, once, with one release event", async () => {
      await run(pre());
      fake.ms += 5_000;
      expect(await run(call(event))).toEqual({ code: 0, out: "" });
      expect(holders()).toEqual([]);
      expect(await run(call(event))).toEqual({ code: 0, out: "" });
      expect(events.filter((e) => e.type === "release")).toEqual([{ type: "release", id: "hook-toolu_1", heldMs: 5_000 }]);
    });

    it("leaves another call's holder alone, and does nothing with the gate off", async () => {
      await run(pre({}, { tool_use_id: "toolu_2" }));
      await run(call(event));
      await run(call(event, { tool_use_id: "toolu_2" }), { CO_LEASE_HOOK: "" });
      expect(holders()).toEqual(["hook-toolu_2.json"]);
    });
  });

  describe("tool_use_id", () => {
    const BAD: [string, unknown][] = [
      ["a slash", "a/b"], ["a parent segment", "../escape"], ["dots only", ".."], ["a leading slash", "/etc/x"], ["a dot", "a.b"], ["a space", "a b"],
      ["empty", ""], ["129 characters", "x".repeat(129)], ["a number", 7], ["null", null],
    ];
    it.each(BAD)("creates and removes nothing for %s, on all three events", async (_name, id) => {
      await run(pre({}, { tool_use_id: "toolu_keep" }));
      writeFileSync(join(dir, "victim.json"), "{}");
      const before = [holders(), readdirSync(dir).sort()];
      for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
        expect(await run(call(event, { tool_use_id: id }))).toEqual({ code: 0, out: "" });
      }
      expect([holders(), readdirSync(dir).sort()]).toEqual(before);
    });

    it("accepts 128 characters of letters, digits, underscore and hyphen", async () => {
      const id = `${"aZ09_-".repeat(22)}ab`.slice(0, 128);
      await run(pre({}, { tool_use_id: id }));
      expect(holders()).toEqual([`hook-${id}.json`]);
    });
  });

  describe("configuration errors", () => {
    it("exits 0 with no output for a relative CO_LEASE_DIR, and writes nothing to stderr", async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      expect(await run(pre(), { CO_LEASE_DIR: "relative/dir" })).toEqual({ code: 0, out: "" });
      expect(stderr).not.toHaveBeenCalled();
    });

    it.each(["PreToolUse", "PostToolUse", "PostToolUseFailure"])("prints nothing to stderr on %s for a bad CO_LEASE_SLOTS and CO_PRESSURE_OVERRIDE and an unwritable directory", async (event) => {
      const stderr = vi.spyOn(process.stderr, "write");
      const { code, out } = await run(call(event), { CO_LEASE_SLOTS: "many", CO_PRESSURE_OVERRIDE: "bogus", CO_LEASE_DIR: unwritableLeaseDir(tmp) }, { level: undefined });
      expect(code).toBe(0);
      expect(out === "" || JSON.parse(out).hookSpecificOutput !== undefined).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
    });

    // A hook that cannot lease stays inert, background calls included.
    it.each<[string, NodeJS.ProcessEnv]>([
      ["a relative CO_LEASE_DIR", { CO_LEASE_DIR: "relative/dir" }],
      ["no CO_LEASE_SESSION_PID", { CO_LEASE_SESSION_PID: undefined }],
    ])("does not deny run_in_background with %s", async (_name, envOver) => {
      expect(await run(pre({ run_in_background: true }), envOver)).toEqual({ code: 0, out: "" });
    });
  });
});
