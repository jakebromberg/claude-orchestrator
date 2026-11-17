import { describe, it, expect } from "vitest";
import { isUiTestArgv, isUiTestCommand, uiRunBackgrounded } from "../src/lease-hook.js";

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
    ["with a destination that has parentheses", `${TOOL} -scheme PhaseMatrix -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' test`],
    ["with a scheme that has a semicolon", `${TOOL} -scheme "My;Scheme" test`],
    ["with a scheme named test and then the action", `${TOOL} -scheme test test`],
    // Issue #324 review (wrappers the owner uses): matched by basename, for the UI classifier only.
    ["under taskpolicy -b", `taskpolicy -b ${TOOL} -scheme App test`],
    ["under taskpolicy with valued options", `taskpolicy -c utility -d throttle -t 2 -l 3 ${TOOL} test`],
    ["under taskpolicy by path and xcrun", `/usr/sbin/taskpolicy -b xcrun ${TOOL} test`],
    ["under caffeinate with flags", `caffeinate -i ${TOOL} test`],
    ["under caffeinate with -t and -w values", `caffeinate -dims -t 3600 -w 123 ${TOOL} test`],
    ["under arch -arm64", `arch -arm64 ${TOOL} test`],
    ["under arch with -e and -arch", `arch -x86_64 -e FOO=1 -d BAR -arch arm64 ${TOOL} test`],
    ["under /usr/bin/time -l", `/usr/bin/time -l ${TOOL} test`],
    ["under time -p", `time -p ${TOOL} test`],
    ["under /usr/bin/time -o file", `/usr/bin/time -al -o out.txt ${TOOL} test`],
    ["under a chain of wrappers", `taskpolicy -b caffeinate -i arch -arm64 /usr/bin/time -l xcrun ${TOOL} test`],
    ["after an option that is a flag, not a valued one", `${TOOL} -retry-tests-on-failure test`],
    ["after -run-tests-until-failure", `${TOOL} -run-tests-until-failure -scheme App test`],
    ["after -quiet and -allowProvisioningUpdates", `${TOOL} -quiet -allowProvisioningUpdates -scheme App test`],
    ["after -parallelize-tests-among-destinations", `${TOOL} -parallelize-tests-among-destinations test`],
    ["after -disable-concurrent-destination-testing", `${TOOL} -disable-concurrent-destination-testing test`],
    // A shell that reads its script from a heredoc runs the body.
    ["a quoted heredoc fed to bash", `bash <<'EOF'\n${TOOL} test -scheme App\nEOF`],
    ["a heredoc fed to sh -s", `sh -s -- arg <<'EOF'\ncd /w\n${TOOL} test\nEOF`],
    ["an unquoted heredoc fed to zsh", `zsh <<EOF\n${TOOL} test -scheme App\nEOF`],
    ["a heredoc fed to /bin/bash behind env", `env FOO=1 /bin/bash <<'EOF'\n${TOOL} test\nEOF`],
    ["a here-string fed to bash", `bash <<< '${TOOL} test -scheme App'`],
    ["a here-string fed to sh -s", `sh -s <<< "${TOOL} test"`],
    ["a here-string glued to its operator", `bash <<<'${TOOL} test -scheme App'`],
    ["a here-string fed to /bin/zsh behind env", `env A=1 /bin/zsh <<< '${TOOL} test'`],
    ["under sudo", `sudo ${TOOL} test`],
    ["under sudo with valued options", `sudo -u jake -g staff -D /w ${TOOL} test`],
    ["under sudo with flags and an assignment", `sudo -n -E FOO=1 ${TOOL} test`],
    ["under /usr/bin/sudo, with -p and -h values", `/usr/bin/sudo -p 'pw: ' -h host ${TOOL} test`],
    ["under sudo around taskpolicy", `sudo taskpolicy -b ${TOOL} test`],
    ["a heredoc fed to bash -e", `bash -e <<-'EOF'\n\t${TOOL} test\nEOF`],
    // Issue #324 review: redirects glued to the action word ended it inside the word, which hid it.
    ["a glued > redirect", `${TOOL} -scheme App test>build.log`],
    ["a glued &> redirect", `${TOOL} -scheme App test&>build.log`],
    ["a glued >> redirect", `${TOOL} test>>build.log 2>&1`],
    ["a glued < redirect", `${TOOL} test<in.txt`],
    ["a glued pipe", `${TOOL} test|tee out.log`],
    ["a spaced redirect and the action after it", `${TOOL} > build.log -scheme App test`],
    ["a numeric redirect before the action", `${TOOL} 2>err.log test`],
    ["a redirect on the wrapper", `taskpolicy -b ${TOOL} test >out.log 2>&1`],
    // timeout and stdbuf, matched by basename.
    ["under script", `script -q /dev/null ${TOOL} test`],
    ["under script with flags and -t", `script -aFkq -t 0 out.log ${TOOL} -scheme App test`],
    ["under script by path", `/usr/bin/script -q typescript ${TOOL} test`],
    ["under script -r with a file", `script -r /tmp/x ${TOOL} test`],
    ["under noglob", `noglob ${TOOL} -destination 'name=A' test`],
    ["under noglob and time", `noglob time ${TOOL} test`],
    ["under script around taskpolicy", `script -q /dev/null taskpolicy -b ${TOOL} test`],
    ["under timeout", `timeout 600 ${TOOL} test`],
    ["under timeout with -k and -s", `timeout -k 5 -s KILL 1h ${TOOL} test`],
    ["under gtimeout", `gtimeout 30m ${TOOL} test`],
    ["under gtimeout by path with options", `/opt/homebrew/bin/gtimeout -k 10s -s TERM 1h ${TOOL} test`],
    ["under stdbuf", `stdbuf -oL -eL ${TOOL} test`],
    ["under stdbuf with valued options", `stdbuf -i 0 -o L -e 0 ${TOOL} test`],
    ["under stdbuf by path", `/usr/local/bin/stdbuf -o0 ${TOOL} test`],
    ["when the text cannot be tokenized and the raw rule sees xcrun --sdk", `echo 'unterminated; xcrun --sdk iphonesimulator ${TOOL} test -scheme App`],
    ["when the text cannot be tokenized and the raw rule sees xcrun -sdk", `echo 'unterminated; xcrun -sdk iphonesimulator ${TOOL} test -scheme App`],
    ["when the text cannot be tokenized and the raw rule sees bash -c --", `echo 'unterminated; bash -c -- "${TOOL} test -scheme App"`],
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
    ["a scheme named test and a build action", `${TOOL} -scheme test build`],
    ["a project named test and a build action", `${TOOL} -project test -scheme App build`],
    ["a scheme named test inside a bash -c script", `bash -c '${TOOL} -scheme test build'`],
    ["taskpolicy with no program to run", `taskpolicy -p 123`],
    ["taskpolicy around another tool that is given the words", `taskpolicy -b grep -rn '${TOOL} test' docs`],
    ["caffeinate around an echo", `caffeinate -i echo ${TOOL} test`],
    ["arch around a grep", `arch -arm64 grep '${TOOL} test' notes.md`],
    ["time around a different tool", `/usr/bin/time -l ls ${TOOL} test`],
    ["a wrapper around a scheme named test and a build action", `taskpolicy -b ${TOOL} -scheme test build`],
    ["a build whose output is redirected to a file named test", `${TOOL} -scheme App build > test`],
    ["a build whose stderr is redirected to a file named test", `${TOOL} -scheme App build 2> test`],
    ["a build with &> to a file named test", `${TOOL} build &> test`],
    ["a build with >> to a file named test", `${TOOL} build >> test`],
    ["a build with a glued redirect to a file named test", `${TOOL} build >test`],
    ["a build that reads a file named test", `${TOOL} build < test`],
    ["a build whose duplicated fd is test", `${TOOL} build 2>&test`],
    ["script around a grep", `script -q /dev/null grep '${TOOL} test' f`],
    ["script with only a file operand", `script -q out.log`],
    ["noglob around an echo", `noglob echo ${TOOL} test`],
    ["timeout around a grep", `timeout 5 grep '${TOOL} test' f`],
    ["gtimeout around an echo", `gtimeout 5 echo ${TOOL} test`],
    ["stdbuf around an echo", `stdbuf -oL echo ${TOOL} test`],
    ["stdbuf with a valued option and a command that is not the build tool", `stdbuf -o L cat ${TOOL}.log test`],
    ["a here-string fed to cat", `cat <<< '${TOOL} test'`],
    ["a here-string fed to a script file", `bash run.sh <<< '${TOOL} test'`],
    ["a here-string to a shell whose text only mentions it", `bash <<< "echo ${TOOL} test"`],
    ["sudo with a user named test and a build action", `sudo -u test ${TOOL} -scheme App build`],
    ["sudo -l, which lists and runs nothing", `sudo -l`],
    ["sudo around a grep", `sudo grep -rn '${TOOL} test' /var/log`],
    ["a heredoc fed to cat", `cat <<'EOF'\n${TOOL} test -scheme App\nEOF`],
    ["a heredoc fed to a script file", `bash run.sh <<'EOF'\n${TOOL} test\nEOF`],
    ["a heredoc fed to bash -c, whose stdin the script ignores", `bash -c 'echo hi' <<'EOF'\n${TOOL} test\nEOF`],
    ["a heredoc to a shell whose body only mentions it", `bash <<'EOF'\necho "${TOOL} test"\nEOF`],
    ["a here-string", `cat <<< '${TOOL} test -scheme App'`],
  ])("does not match %s", (_name, command) => {
    expect(isUiTestCommand(command)).toBe(false);
  });

  // `bash -c "..."` scripts are read recursively to a fixed depth, beyond which the raw rule answers; a deeper nest must neither throw nor hang.
  const nest = (command: string, levels: number): string => {
    let text = command;
    for (let i = 0; i < levels; i++) text = `bash -c "${text.replace(/(["\\$`])/g, "\\$1")}"`;
    return text;
  };

  it.each([1, 3, 6])("reads a test action nested %i bash -c scripts deep", (levels) => {
    expect(isUiTestCommand(nest(`${TOOL} test -scheme App`, levels))).toBe(true);
    expect(isUiTestCommand(nest(`echo "${TOOL} test"`, levels))).toBe(false);
  });

  it("answers, without throwing, for a nest past the depth bound", () => {
    expect(typeof isUiTestCommand(nest(`${TOOL} test -scheme App`, 14))).toBe("boolean");
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

// Issue #324 review: `XCODEBUILD_VALUED` is the option list of the build tool's manual (`man xcodebuild`), each entry one that takes a value; the flags
// below take none, so the word after them is an argument or the action.
describe("xcodebuild options and the action word", () => {
  const VALUED = [
    "project", "target", "workspace", "scheme", "destination", "destination-timeout", "configuration", "arch", "sdk", "enableAddressSanitizer",
    "enableThreadSanitizer", "enableUndefinedBehaviorSanitizer", "enableCodeCoverage", "testLanguage", "testRegion", "derivedDataPath",
    "resultBundlePath", "authenticationKeyPath", "authenticationKeyID", "authenticationKeyIssuerID", "archivePath", "exportPath", "exportOptionsPlist",
    "localizationPath", "exportLanguage", "xcconfig", "testProductsPath", "xctestrun", "testPlan", "skip-testing", "only-testing", "skip-test-configuration",
    "only-test-configuration", "maximum-concurrent-test-device-destinations", "maximum-concurrent-test-simulator-destinations", "parallel-testing-enabled",
    "parallel-testing-worker-count", "maximum-parallel-testing-workers", "test-timeouts-enabled", "default-test-execution-time-allowance",
    "maximum-test-execution-time-allowance", "test-iterations", "test-repetition-relaunch-enabled", "collect-test-diagnostics", "test-enumeration-style",
    "test-enumeration-format", "test-enumeration-output-path", "toolchain",
  ];
  const FLAGS = [
    "retry-tests-on-failure", "run-tests-until-failure", "disable-concurrent-destination-testing", "parallelize-tests-among-destinations", "enumerate-tests",
    "quiet", "verbose", "allowProvisioningUpdates", "allowProvisioningDeviceRegistration", "skipUnavailableActions", "alltargets", "showBuildSettings",
  ];

  it.each(VALUED)("-%s takes a value, so a value that reads test is not the action", (option) => {
    expect(isUiTestArgv([TOOL, `-${option}`, "test", "build"])).toBe(false);
    expect(isUiTestArgv([TOOL, `-${option}`, "x", "test"])).toBe(true);
    expect(isUiTestCommand(`${TOOL} -${option} test build`)).toBe(false);
  });

  it.each(FLAGS)("-%s takes no value, so the word after it is the action", (option) => {
    expect(isUiTestArgv([TOOL, `-${option}`, "test"])).toBe(true);
    expect(isUiTestCommand(`${TOOL} -${option} test`)).toBe(true);
  });
});

// Issue #324 review: the tokenizer decides whether a UI-test run is backgrounded (and so would lose its slots when the shell returns): the
// simple command that runs it, or a pipeline, group or subshell holding it, is followed by an `&` separator.
describe("uiRunBackgrounded", () => {
  it.each<[string, string]>([
    ["a trailing &", `${TOOL} test &`],
    ["a & after redirects, then another command", `${TOOL} -scheme App test > x.log 2>&1 & echo $!`],
    ["a subshell that backgrounds it", `(${TOOL} test &)`],
    ["a & then sleep", `${TOOL} test & sleep 5`],
    ["a backgrounded subshell", `(${TOOL} test) &`],
    ["a backgrounded group", `{ ${TOOL} test; } &`],
    ["a pipeline element that is backgrounded", `${TOOL} test | tee out.log &`],
    ["an and-or list that is backgrounded", `cd /w && ${TOOL} test &`],
    ["a wrapper around it", `taskpolicy -b ${TOOL} test &`],
    ["a glued redirect before the &", `${TOOL} test>x.log &`],
    ["a bash -c script that is backgrounded", `bash -c '${TOOL} test' &`],
    ["a bash -c script that backgrounds it itself", `bash -c '${TOOL} test &'`],
    ["a heredoc script that backgrounds it", `bash <<'EOF'\n${TOOL} test &\nEOF`],
    ["a & on the following line", `${TOOL} test &\nwait`],
    // Issue #324 review: a newline after `|`, `&&`, `||` or `|&` continues the statement.
    ["a pipe then a newline", `${TOOL} test |\n  tee log &`],
    ["a redirect, a pipe then a newline", `${TOOL} -scheme A test 2>&1 |\n  xcbeautify > out.log &`],
    ["&& then a newline", `${TOOL} test &&\n  echo done &`],
    ["|| then a newline", `${TOOL} test ||\n  echo failed &`],
    ["|& then a newline", `${TOOL} test |&\n  tee log &`],
    // Issue #324 review: text that defines a function and has a lone & is decided by the conservative raw check, whatever the body.
    ["a space before the parentheses", `f () { ${TOOL} test; }; f &`],
    ["the function keyword without parentheses", `function f { ${TOOL} test; }; f &`],
    ["the function keyword without parentheses, called through time", `function f { ${TOOL} test; }; time f &`],
    ["the function keyword with parentheses", `function f() { ${TOOL} test; }; f &`],
    ["a subshell body", `f() ( ${TOOL} test ); f &`],
    ["a zsh body with no semicolon", `f() { ${TOOL} test }; f &`],
    ["time in front of the call", `f() { ${TOOL} test; }; time f &`],
    ["a group around the call", `f() { ${TOOL} test; }; { f; } &`],
    ["a call through another function", `f() { ${TOOL} test; }; g() { f; }; g &`],
    ["a different function's call in the background (conservative)", `f() { ${TOOL} test; }; g &`],
    ["a function and a & elsewhere on the line", `f() { ${TOOL} test; }; f; echo hi &`],
    ["text that cannot be tokenized and holds a lone &", `echo 'unterminated; ${TOOL} test &`],
    // Compound commands: the & after the closer backgrounds the whole statement.
    ["an if", `if true; then ${TOOL} test; fi &`],
    ["an if with else", `if c; then echo x; else ${TOOL} -scheme A test; fi &`],
    ["a for loop with redirects", `for s in A B; do ${TOOL} -scheme $s test; done > log 2>&1 &`],
    ["a while loop", `while true; do ${TOOL} test; done &`],
    ["an until loop", `until false; do ${TOOL} test; done &`],
    ["a case", `case $x in a) ${TOOL} test ;; esac &`],
    ["a nested compound", `if c; then for s in A; do ${TOOL} test; done; fi &`],
    ["a compound after cd", `cd /w && if c; then ${TOOL} test; fi &`],
    ["a function whose call is backgrounded", `f() { ${TOOL} test; }; f &`],
    ["a function keyword whose call is backgrounded", `function f { ${TOOL} test; }; f &`],
    ["a function called in a backgrounded pipeline", `f() { ${TOOL} test; }; f | tee log &`],
    ["a coproc", `coproc ${TOOL} test`],
    ["a named coproc", `coproc BUILD ${TOOL} -scheme A test`],
    ["a coproc group", `coproc { ${TOOL} test; }`],
    ["an output process substitution", `tee out.log >(${TOOL} test)`],
    ["an input process substitution", `cat <(${TOOL} test)`],
    ["text that cannot be tokenized and holds a coproc", `echo 'unterminated; coproc ${TOOL} test`],
    ["text that cannot be tokenized and holds a process substitution", `echo 'unterminated; cat <(${TOOL} test)`],
  ])("is true for %s", (_name, command) => {
    expect(isUiTestCommand(command)).toBe(true);
    expect(uiRunBackgrounded(command)).toBe(true);
  });

  it.each<[string, string]>([
    ["a foreground run", `${TOOL} test`],
    ["redirects and a pipe", `${TOOL} test 2>&1 | tail`],
    ["&&", `cd /w && ${TOOL} test`],
    ["&> as a redirect", `${TOOL} test &>build.log`],
    ["|& as a pipe", `${TOOL} test |& tail`],
    ["a quoted &", `${TOOL} -destination 'name=A & B' test`],
    ["a & that backgrounds a command before it, not the run", `echo hi & ${TOOL} test`],
    ["a & on an earlier line", `echo hi &\n${TOOL} test`],
    ["a & after a ; that ends the run's statement", `${TOOL} test; echo hi &`],
    ["a backgrounded subshell that does not hold the run", `(sleep 5) & ${TOOL} test`],
    ["a backgrounded command that is not a UI run", "npm test &"],
    ["text that only mentions the build tool", `echo '${TOOL} test' &`],
    ["a compound in the foreground", `if true; then ${TOOL} test; fi`],
    ["a for loop in the foreground", `for s in A B; do ${TOOL} -scheme $s test; done`],
    ["a function called in the foreground", `f() { ${TOOL} test; }; f`],
    ["a continued pipeline and then a backgrounded other command", `${TOOL} test |\n  tee log\necho hi &`],
    ["a continued and-or list in the foreground", `${TOOL} test &&\n  echo done`],
    ["a function defined and called in the foreground", `f () { ${TOOL} test; }; f`],
    ["a function that runs no UI test, called in the background", `f() { echo hi; }; f &`],
    ["a compound followed by a backgrounded other command", `if true; then ${TOOL} test; fi; echo hi &`],
    ["a here-string, not a process substitution", `cat <<< '${TOOL} test'`],
    ["a build in a process substitution", `cat <(${TOOL} build)`],
    ["a coproc of another command", `coproc cat ${TOOL}`],
  ])("is false for %s", (_name, command) => {
    expect(uiRunBackgrounded(command)).toBe(false);
  });
});
