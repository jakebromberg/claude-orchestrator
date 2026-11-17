import { describe, it, expect } from "vitest";
import { isUiTestCommand } from "../src/lease-hook.js";

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
