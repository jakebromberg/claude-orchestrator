import { describe, it, expect } from "vitest";
import { isUiTestArgv, isUiTestCommand } from "../src/lease-hook.js";

// Issue #324, defects 2 and 4. The UI-test class takes a real invocation of the build tool with a test action, in command
// position, and nothing else. The stopgap weight rule matched the words anywhere in the text, so a `grep` whose pattern said
// them, or a `gh issue create` whose body quoted them, waited in the queue as if it were a UI run (one grep about 4 minutes).

const TOOL = "xcodebuild";
const SIM = "-destination 'platform=iOS Simulator,name=iPhone 16'";

describe("isUiTestCommand", () => {
  it.each<[string, string]>([
    ["the test action", `${TOOL} test -scheme App ${SIM}`],
    ["the test action last", `${TOOL} -scheme App ${SIM} -only-testing:AppUITests/LoginTests test`],
    ["test-without-building", `${TOOL} test-without-building -xctestrun /x/App.xctestrun ${SIM}`],
    ["a preceding action", `${TOOL} clean test -scheme App`],
    ["through xcrun", `xcrun ${TOOL} test -scheme App`],
    ["through xcrun with --sdk", `xcrun --sdk iphonesimulator ${TOOL} test -scheme App`],
    ["through xcrun with -sdk", `xcrun -sdk iphonesimulator ${TOOL} test -scheme App`],
    ["under bash -c --", `bash -c -- '${TOOL} test -scheme App'`],
    ["under sh -e -c -- with a double-quoted script", `sh -e -c -- "${TOOL} -scheme App test"`],
    ["by path", `/Applications/Xcode.app/Contents/Developer/usr/bin/${TOOL} test -scheme App`],
    ["a quoted path", `"/Applications/Xcode.app/Contents/Developer/usr/bin/${TOOL}" test -scheme App`],
    ["after cd and &&", `cd /work && ${TOOL} test -scheme App`],
    ["after cd and ;", `cd /work;${TOOL} test -scheme App`],
    ["in a pipeline", `${TOOL} test -scheme App 2>&1 | tail -50`],
    ["in a subshell", `(${TOOL} test -scheme App)`],
    ["after an assignment", `DEVELOPER_DIR=/Applications/Xcode.app ${TOOL} test -scheme App`],
    ["under env, time and nice", `env -u FOO time nice -n 5 ${TOOL} test -scheme App`],
    ["under bash -c", `bash -c '${TOOL} test -scheme App'`],
    ["under sh -lc", `sh -lc "cd /work && ${TOOL} test -scheme App"`],
    ["after set -o pipefail", `set -o pipefail && ${TOOL} test -scheme App | xcpretty`],
    ["with a tab between words", `${TOOL}\ttest\t-scheme\tApp`],
    ["across a line continuation", `${TOOL} \\\n  -scheme App \\\n  test`],
    ["in an if", `if ${TOOL} test -scheme App; then echo ok; fi`],
    ["inside a command substitution", `echo "result: $(${TOOL} test -scheme App)"`],
    ["inside backticks", `out=\`${TOOL} test -scheme App\``],
    ["inside an unquoted heredoc's substitution", `cat <<EOF\nlog: $(${TOOL} test -scheme App)\nEOF`],
    ["after a heredoc ends", `cat <<'EOF' > notes.txt\n${TOOL} test is slow\nEOF\n${TOOL} test -scheme App`],
    ["on the line after a comment", `# run the suite\n${TOOL} test -scheme App`],
    ["in a bash -c script with a quoted separator", `bash -c 'echo "a;b"; ${TOOL} test -scheme App'`],
    ["through env with options and assignments", `env -i PATH=/usr/bin FOO='a b' ${TOOL} test -scheme App`],
    ["through xcrun with an sdk option", `xcrun --sdk iphonesimulator ${TOOL} test -scheme App`],
    ["from a path with spaces in quotes", `"/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/${TOOL}" test -scheme App`],
    ["when the tool name is quoted in pieces", `"xcode"'build' test -scheme App`],
    ["when a quoted argument holds the words and a real action follows", `${TOOL} -destination 'platform=iOS Simulator,name=iPhone 16' -scheme "My Test App" test`],
    ["when the text before it holds an unbalanced quote in a comment", `# it's fine\n${TOOL} test -scheme App`],
    ["when the text cannot be tokenized and the raw rule matches", `echo 'unterminated; ${TOOL} test -scheme App`],
  ])("matches %s", (_name, command) => {
    expect(isUiTestCommand(command)).toBe(true);
  });

  it.each<[string, string]>([
    ["a grep for the words", `grep -rn "${TOOL} test" docs/`],
    ["a grep -e for the words", `grep -E '${TOOL}.*test' scripts/*.sh`],
    ["an echo of the words", `echo ${TOOL} test`],
    ["a commit message", `git commit -m "docs: run ${TOOL} test before pushing"`],
    ["a gh issue body on one line", `gh issue create --title t --body "Run ${TOOL} test -scheme App here"`],
    ["a cat of a file named for it", `cat ${TOOL}-test.log`],
    ["rg for the words", `rg '${TOOL} .* test' -g '*.sh'`],
    ["a build action", `${TOOL} build -scheme App ${SIM}`],
    ["build-for-testing", `${TOOL} build-for-testing -scheme App ${SIM}`],
    ["the archive action", `${TOOL} archive -scheme App`],
    ["a settings query", `${TOOL} -showBuildSettings -scheme App`],
    ["no action at all", TOOL],
    ["a similarly named tool", `my${TOOL} test`],
    ["a longer tool name", `${TOOL}-wrapper test`],
    ["a longer action", `${TOOL} testing -scheme App`],
    ["a plain unit-test command", "npm test"],
    ["a command whose later segment only mentions it", `ls && echo "${TOOL} test"`],
    ["a pipeline that greps its output", `cat build.log | grep '${TOOL} test'`],
    ["a path component", `ls /var/${TOOL}/test`],
    ["an empty command", ""],
    ["a quoted commit message with a separator before the words", `git commit -m "fix; ${TOOL} test hung"`],
    ["a quoted gh body with && before the words", `gh issue create --title t --body "a && ${TOOL} test -scheme App"`],
    ["a single-quoted argument with a newline before the words", `gh issue create --body 'first line\n${TOOL} test -scheme App\nlast'`],
    ["a quoted heredoc body line that starts with the words", `gh issue create --title t --body-file - <<'EOF'\nSteps:\n${TOOL} test -scheme App\nEOF`],
    ["a quoted heredoc body in the commit-message form", `git commit -m "$(cat <<'EOF'\nDon't (yet) run\n${TOOL} test -scheme App\nEOF\n)"`],
    ["an unquoted heredoc body with plain text", `cat <<EOF\n${TOOL} test -scheme App\nEOF`],
    ["a comment line", `# ${TOOL} test -scheme App`],
    ["a trailing comment", `ls # ${TOOL} test`],
    ["a comment line after a command", `ls\n# ${TOOL} test -scheme App`],
    ["an escaped separator", `echo a\\; ${TOOL} test`],
    ["an echo of a substitution-free string after a real build", `${TOOL} build -scheme App && echo "now ${TOOL} test"`],
    ["a single-quoted substitution", `echo '$(${TOOL} test -scheme App)'`],
    ["a bash -c script that only echoes it", `bash -c 'echo "${TOOL} test"'`],
    ["an argument that is the words", `printf '%s\n' ${TOOL} test`],
    ["a here-string", `cat <<< '${TOOL} test -scheme App'`],
  ])("does not match %s", (_name, command) => {
    expect(isUiTestCommand(command)).toBe(false);
  });

  it("stays linear on a long command with many words and no test action", () => {
    const long = `${TOOL} ${"-flag value ".repeat(5_000)}build`;
    const start = performance.now();
    expect(isUiTestCommand(long)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

// Issue #324 review: `claude-orchestrator-lease -- <argv>` has its words already, so they are read as words; joining them with spaces loses
// the quoting that tells a destination's parentheses or a scheme's `;` from shell syntax.
describe("isUiTestArgv", () => {
  it.each<[string, string[], boolean]>([
    ["a destination with parentheses and spaces", [TOOL, "-scheme", "PhaseMatrix", "-destination", "platform=iOS Simulator,name=iPad Pro 13-inch (M5)", "test"], true],
    ["a scheme with a semicolon", [TOOL, "-scheme", "My;Scheme", "test"], true],
    ["a bash -c script", ["bash", "-c", `${TOOL} -scheme S test`], true],
    ["a bash -c script with a quoted destination", ["sh", "-lc", `${TOOL} -destination 'platform=iOS Simulator,name=iPhone 16' test`], true],
    ["xcrun and an only-testing option", ["xcrun", TOOL, "-scheme", "S", "-only-testing:AppUITests/LoginTests", "test"], true],
    ["test-without-building", [TOOL, "test-without-building", "-xctestrun", "x"], true],
    ["a path to the tool", [`/Applications/Xcode Beta 2.app/Contents/Developer/usr/bin/${TOOL}`, "test"], true],
    ["env and an assignment first", ["env", "FOO=1", TOOL, "test"], true],
    ["a build action", [TOOL, "-scheme", "S", "build"], false],
    ["build-for-testing", [TOOL, "build-for-testing", "-scheme", "S"], false],
    ["a scheme named test", [TOOL, "-scheme", "test", "build"], false],
    ["a project named test", [TOOL, "-project", "test", "-scheme", "S", "build"], false],
    ["a destination named test", [TOOL, "-destination", "test", "build"], false],
    ["a scheme named test and then the action", [TOOL, "-scheme", "test", "test"], true],
    ["another tool given the words", ["grep", "-rn", `${TOOL} test`, "docs"], false],
    ["echo of the words", ["echo", TOOL, "test"], false],
    ["a bash -c script that only echoes it", ["bash", "-c", `echo "${TOOL} test"`], false],
    ["bash -c --", ["bash", "-c", "--", `${TOOL} -scheme S test`], true],
    ["xcrun -sdk", ["xcrun", "-sdk", "iphonesimulator", TOOL, "test"], true],
    ["no words", [], false],
  ])("%s", (_name, argv, expected) => {
    expect(isUiTestArgv(argv)).toBe(expected);
  });
});
