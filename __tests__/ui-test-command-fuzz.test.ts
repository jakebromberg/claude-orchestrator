import { describe, it, expect } from "vitest";
import { isUiTestCommand, isUiTestCommandUntokenized } from "../src/lease-hook.js";

// Issue #324 defect 4 and #302's owner decision: the classifier is checked by a seeded generative differential, not a few rows. Each
// command is built from pieces whose truth is known by construction (a real invocation in command position, or text that only
// mentions it somewhere a shell does not run it), and `isUiTestCommand` must agree with that construction on every one. The same
// commands also run through the untokenized segment rule it replaces, to show the generator reaches what the tokenizer fixes.

const TOOL = "xcodebuild";

const REAL_FORMS = [
  `${TOOL} test -scheme A`,
  `xcrun ${TOOL} test-without-building -xctestrun x.xctestrun`,
  `env FOO=1 ${TOOL} test`,
  `time ${TOOL} clean test -scheme A`,
  `"/Applications/Xcode Beta.app/Contents/Developer/usr/bin/${TOOL}" test -scheme A`,
  `bash -c '${TOOL} test -scheme A'`,
  `FOO='a b' ${TOOL} -destination 'platform=iOS Simulator,name=iPhone' test`,
  `nice -n 5 ${TOOL} test`,
  // The wrappers the owner uses, matched by basename.
  `taskpolicy -b ${TOOL} test -scheme A`,
  `taskpolicy -c utility -t 2 ${TOOL} test`,
  `caffeinate -dims -t 3600 ${TOOL} test`,
  `arch -arm64 -e FOO=1 ${TOOL} test`,
  `/usr/bin/time -l -o /dev/null xcrun ${TOOL} test`,
  `${TOOL} -retry-tests-on-failure -scheme A test`,
  // Redirects glued to the action word, and the wrappers added after the review.
  `${TOOL} -scheme A test>build.log`,
  `${TOOL} test&>build.log`,
  `${TOOL} test 2>&1`,
  `${TOOL} test<in.txt`,
  `gtimeout 30m ${TOOL} test`,
  `timeout -k 5 600 ${TOOL} test`,
  `stdbuf -oL -eL ${TOOL} test`,
];

const REAL_PLACEMENTS: ((t: string) => string)[] = [
  (t) => t,
  (t) => `cd /w && ${t}`,
  (t) => `cd /w;${t}`,
  (t) => `false || ${t}`,
  (t) => `echo hi | ${t}`,
  (t) => `(${t})`,
  (t) => `{ ${t}; }`,
  (t) => `if ${t}; then echo ok; fi`,
  (t) => `echo $(${t})`,
  (t) => `echo "out: $(${t})"`,
  (t) => `out=\`${t}\``,
  (t) => `# note\n${t}`,
  (t) => `cat <<'EOF' > f.txt\nbody\nEOF\n${t}`,
  (t) => `${t} 2>&1 | tail -20`,
  (t) => `${t} &`,
  (t) => `set -o pipefail && ${t} | xcpretty`,
  (t) => `cat <<EOF\nlog: $(${t})\nEOF`,
];

// Real invocations the generator does not build, written by hand: forms from the review that the placements could break (a heredoc
// needs its delimiter on a line of its own) or that the generator's own vocabulary would not reach.
const EXTRA_REAL = [
  `bash <<'EOF'\n${TOOL} test -scheme A\nEOF`,
  `sh -s -- a b <<'EOF'\ncd /w\n${TOOL} test\nEOF`,
  `zsh <<EOF\n${TOOL} test\nEOF`,
  `env FOO=1 /bin/bash <<-'EOF'\n\t${TOOL} test\nEOF`,
  `taskpolicy -b caffeinate -i arch -arm64 /usr/bin/time -l xcrun --sdk iphonesimulator ${TOOL} test`,
  `${TOOL} -quiet -allowProvisioningUpdates -parallelize-tests-among-destinations -scheme A test-without-building`,
  `bash -c -- '${TOOL} -scheme A test'`,
  `taskpolicy -b ${TOOL} -scheme A test>build.log 2>&1`,
  `sudo -u jake gtimeout 1h stdbuf -o0 ${TOOL} test&>x.log`,
  `bash <<< '${TOOL} test>out.log'`,
  `echo start && taskpolicy -b ${TOOL} -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' test`,
];

const EXTRA_MENTION = [
  `cat <<'EOF'\n${TOOL} test\nEOF`,
  `bash script.sh <<'EOF'\n${TOOL} test\nEOF`,
  `taskpolicy -b grep '${TOOL} test' f`,
  `caffeinate -i echo ${TOOL} test`,
  `${TOOL} -scheme test build`,
  `bash <<'EOF'\necho '${TOOL} test'\nEOF`,
  `${TOOL} -scheme A build > test`,
  `${TOOL} build 2> test`,
  `${TOOL} build &> test`,
  `timeout 5 grep '${TOOL} test' f`,
  `stdbuf -oL echo ${TOOL} test`,
];

const MENTIONS = [`${TOOL} test`, `${TOOL} test -scheme A`, `${TOOL} test-without-building -xctestrun x`, `run ${TOOL} test first`];

const MENTION_PLACEMENTS: ((m: string) => string)[] = [
  (m) => `echo ${m}`,
  (m) => `grep -rn "${m}" docs/`,
  (m) => `git commit -m "fix; ${m}"`,
  (m) => `git commit -m "a && ${m}"`,
  (m) => `gh issue create --title t --body "intro\n${m}"`,
  (m) => `gh issue create --body 'l1\n${m}\nl3'`,
  (m) => `gh issue create --body-file - <<'EOF'\nl1\n${m}\nEOF`,
  (m) => `cat <<'EOF'\n${m}\nEOF`,
  (m) => `cat <<EOF\n${m}\nEOF`,
  (m) => `ls # ${m}`,
  (m) => `# ${m}`,
  (m) => `ls\n# ${m}\nls`,
  (m) => `echo '$(${m})'`,
  (m) => `git commit -m "$(cat <<'EOF'\nIt's (x), really\n${m}\nEOF\n)"`,
  (m) => `printf '%s ' ${m.split(" ").join(" ")}`,
  (m) => `bash -c 'echo "${m}"'`,
  (m) => `echo a\\; ${m}`,
  (m) => `cat <<< '${m}'`,
  (m) => `rg '${m}' -g '*.md'`,
  (m) => `echo "${m}" > notes.txt`,
];

const JOINERS = [" && ", "; ", "\n", " | ", " || "];

/** mulberry32: a seeded generator, so a failure names its seed and reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(seed: number): { command: string; real: boolean } {
  const next = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const pieces = 1 + Math.floor(next() * 3);
  const parts: string[] = [];
  let real = false;
  for (let i = 0; i < pieces; i++) {
    if (next() < 0.4) {
      parts.push(pick(REAL_PLACEMENTS)(pick(REAL_FORMS)));
      real = true;
    } else parts.push(pick(MENTION_PLACEMENTS)(pick(MENTIONS)));
  }
  // A heredoc must end with its delimiter line, and a comment runs to the end of its line, so a piece with either is followed by a new line.
  const joiner = parts.some((p) => p.includes("<<") || p.includes("#")) ? "\n" : pick(JOINERS);
  return { command: parts.join(joiner), real };
}

describe("isUiTestCommand against the generator (seeded)", () => {
  const SEEDS = Array.from({ length: 6_000 }, (_, i) => i + 1);

  it("agrees with the construction on every generated command", () => {
    const wrong = SEEDS.flatMap((seed) => {
      const { command, real } = generate(seed);
      return isUiTestCommand(command) === real ? [] : [{ seed, real, command }];
    });
    expect(wrong.slice(0, 3)).toEqual([]);
  });

  it("reaches what the tokenizer fixes: the untokenized rule matches mention-only commands the tokenizer does not", () => {
    const mentionOnly = SEEDS.map(generate).filter((g) => !g.real);
    expect(mentionOnly.length).toBeGreaterThan(500);
    const rawFalsePositives = mentionOnly.filter((g) => isUiTestCommandUntokenized(g.command));
    expect(rawFalsePositives.length).toBeGreaterThan(50);
    expect(rawFalsePositives.filter((g) => isUiTestCommand(g.command))).toEqual([]);
  });

  it("never loses a real invocation the untokenized rule finds", () => {
    const lost = SEEDS.map(generate).filter((g) => g.real && isUiTestCommandUntokenized(g.command) && !isUiTestCommand(g.command));
    expect(lost.slice(0, 3)).toEqual([]);
  });

  it("covers every real form and every placement of both kinds", () => {
    // Non-vacuity of the generator itself: a placement the seeds never use would pin nothing.
    const used = new Set<string>();
    for (const seed of SEEDS) used.add(generate(seed).command);
    const fragments = (place: (x: string) => string): string[] => place("@@").split("@@");
    for (const place of REAL_PLACEMENTS) expect([...used].some((c) => fragments(place).every((frag) => c.includes(frag)))).toBe(true);
    for (const place of MENTION_PLACEMENTS) expect([...used].some((c) => fragments(place).every((frag) => c.includes(frag)))).toBe(true);
  });

  it("reads every hand-written real invocation as one, and every hand-written mention as text", () => {
    expect(EXTRA_REAL.filter((c) => !isUiTestCommand(c))).toEqual([]);
    expect(EXTRA_MENTION.filter((c) => isUiTestCommand(c))).toEqual([]);
  });

  it("never loses a real invocation the untokenized rule finds, over a corpus that includes forms the generator did not build", () => {
    const corpus = [...SEEDS.map(generate).filter((g) => g.real).map((g) => g.command), ...EXTRA_REAL];
    expect(corpus.length).toBeGreaterThan(1_000);
    expect(corpus.filter((c) => isUiTestCommandUntokenized(c) && !isUiTestCommand(c))).toEqual([]);
    // The corpus is not vacuous: the untokenized rule finds a share of it, and the tokenizer finds all.
    expect(corpus.filter((c) => isUiTestCommandUntokenized(c)).length).toBeGreaterThan(500);
    expect(corpus.filter((c) => !isUiTestCommand(c))).toEqual([]);
  });
});
