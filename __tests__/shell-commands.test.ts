import { describe, it, expect } from "vitest";
import { shellCommands, simpleCommands } from "../src/shell-commands.js";

// Issue #324 defect 4 and #302's owner decision: classifying a command by what it runs needs a tokenizer that knows quotes,
// escapes, comments, heredocs and substitutions, and that gives up (undefined) on anything it cannot parse so the caller can fall back.

describe("simpleCommands", () => {
  it.each<[string, string, string[][]]>([
    ["one command", "ls -la /tmp", [["ls", "-la", "/tmp"]]],
    ["empty text", "", []],
    ["only whitespace", "  \t ", []],
    ["a semicolon", "a b; c d", [["a", "b"], ["c", "d"]]],
    ["&& and ||", "a && b || c", [["a"], ["b"], ["c"]]],
    ["a pipe", "a | b -x", [["a"], ["b", "-x"]]],
    ["a background &", "a & b", [["a"], ["b"]]],
    ["a newline", "a\nb c", [["a"], ["b", "c"]]],
    ["a subshell", "(a; b) c", [["a"], ["b"], ["c"]]],
    ["a brace group", "{ a; }", [["{", "a"], ["}"]]],
    ["a redirect that holds a &", "a 2>&1 | b", [["a"], ["b"]]],
    ["&> and >&", "a &> f; b >&2", [["a"], ["b"]]],
    // A redirect operator ends the word before it, and its target is not a word (issue #324 review: `test>build.log` hid the action word).
    ["a glued > redirect", "a test>x.log", [["a", "test"]]],
    ["a glued &> redirect", "a test&>x.log", [["a", "test"]]],
    ["a glued >> redirect", "a test>>x.log b", [["a", "test", "b"]]],
    ["a glued < redirect", "a test<in.txt", [["a", "test"]]],
    ["a spaced redirect and a word after its target", "a > f b", [["a", "b"]]],
    ["a redirect before the words", "> f a b", [["a", "b"]]],
    ["a numeric fd kept with its operator", "a 2>f b", [["a", "b"]]],
    ["a numeric fd and a duplication", "a 2>&1 b", [["a", "b"]]],
    ["a duplication to a closed fd", "a >&- b", [["a", "b"]]],
    ["&>> and >|", "a &>>f b >|g", [["a", "b"]]],
    ["<>", "a <>f b", [["a", "b"]]],
    ["a word that only ends in a digit is a word", "a test2>x", [["a", "test2"]]],
    ["a digit word apart from the operator is an argument", "a 2 >x", [["a", "2"]]],
    ["a quoted digit is not an fd", `a "2">x`, [["a", "2"]]],
    ["a quoted > is text", `a ">" b`, [["a", ">", "b"]]],
    ["an escaped > is text", "a \\> b", [["a", ">", "b"]]],
    ["a redirect target ends at the separator", "a >f; b", [["a"], ["b"]]],
    ["a redirect target that is quoted", `a > "f g" b`, [["a", "b"]]],
    ["a redirect with no target at the end", "a >", [["a"]]],
    ["single quotes", "echo 'a b; c && d'", [["echo", "a b; c && d"]]],
    ["double quotes", 'echo "a b; c && d"', [["echo", "a b; c && d"]]],
    ["quotes joined to a word", `a"b c"'d e'f`, [["ab cd ef"]]],
    ["an empty quoted word", `a "" b`, [["a", "", "b"]]],
    ["an escaped space", "a b\\ c d", [["a", "b c", "d"]]],
    ["an escaped quote", `a \\"b c\\"`, [["a", '"b', 'c"']]],
    ["an escaped quote inside double quotes", 'a "b \\" c; d"', [["a", 'b " c; d']]],
    ["a backslash newline", "a b \\\n c", [["a", "b", "c"]]],
    ["a backslash inside single quotes", "a 'b\\' c", [["a", "b\\", "c"]]],
    ["ANSI-C quoting", "a $'b\\' c; d' e", [["a", "b' c; d", "e"]]],
    ["a comment line", "a b\n# c; d\ne", [["a", "b"], ["e"]]],
    ["a trailing comment", "a b # c && d", [["a", "b"]]],
    ["a # inside a word", "a b#c", [["a", "b#c"]]],
    ["a # inside quotes", "a '# b' \"# c\"", [["a", "# b", "# c"]]],
    ["a command substitution", "a $(b c) d", [["b", "c"], ["a", "", "d"]]],
    ["a substitution inside double quotes", 'a "x $(b c) y"', [["b", "c"], ["a", "x  y"]]],
    ["a nested substitution", "a $(b $(c d))", [["c", "d"], ["b", ""], ["a", ""]]],
    ["a parenthesis inside a substitution", "a $( (b); c )", [["b"], ["c"], ["a", ""]]],
    ["backticks", "a `b c` d", [["b", "c"], ["a", "", "d"]]],
    ["a single-quoted substitution is text", "a '$(b c)'", [["a", "$(b c)"]]],
    ["arithmetic", "a $((1+2)) b", [["1+2"], ["a", "", "b"]]],
  ])("splits %s", (_name, text, expected) => {
    const got = simpleCommands(text)!;
    // Order of the nested commands is by completion; only the multiset matters to a caller.
    expect(got.map((w) => w.join("\u0000")).sort()).toEqual(expected.map((w) => w.join("\u0000")).sort());
  });

  describe("heredocs", () => {
    it("skips a quoted body, whatever it says", () => {
      expect(simpleCommands("cat <<'EOF'\nrun a; b && c\n$(d e)\nEOF\nf")).toEqual([["cat"], ["f"]]);
    });
    it("skips a double-quoted delimiter's body too", () => {
      expect(simpleCommands('cat <<"END"\na; b\nEND\nf')).toEqual([["cat"], ["f"]]);
    });
    it("finds the commands an unquoted body substitutes", () => {
      expect(simpleCommands("cat <<EOF\nplain a; b\n$(d e)\n`g h`\nEOF\nf")).toEqual(expect.arrayContaining([["d", "e"], ["g", "h"], ["f"]]));
      expect(simpleCommands("cat <<EOF\nplain a; b\nEOF")).toEqual([["cat"]]);
    });
    it("does not treat an escaped substitution in an unquoted body as one", () => {
      expect(simpleCommands("cat <<EOF\n\\$(d e)\nEOF")).toEqual([["cat"]]);
    });
    it("ends at the delimiter line only, and with <<- ignores leading tabs", () => {
      expect(simpleCommands("cat <<EOF\nEOF x\n EOF\nEOF\nf")).toEqual([["cat"], ["f"]]);
      expect(simpleCommands("cat <<-EOF\n\tbody\n\tEOF\nf")).toEqual([["cat"], ["f"]]);
    });
    it("handles two heredocs on one line in order", () => {
      expect(simpleCommands("cat <<A <<'B'\none\nA\ntwo\nB\nf")).toEqual([["cat"], ["f"]]);
    });
    it("keeps the rest of the line after the heredoc operator", () => {
      expect(simpleCommands("cat <<'EOF' > out.txt && g\nbody\nEOF")).toEqual([["cat"], ["g"]]);
    });
    it("handles the commit-message form inside a substitution, apostrophes and parentheses in the body included", () => {
      const text = "git commit -m \"$(cat <<'EOF'\nIt doesn't (yet) run a; b\nEOF\n)\" && c";
      expect(simpleCommands(text)).toEqual(expect.arrayContaining([["cat"], ["git", "commit", "-m", ""], ["c"]]));
      expect(simpleCommands(text)!.some((w) => w.includes("doesn't"))).toBe(false);
    });
    it("is not a here-string", () => {
      expect(simpleCommands("cat <<< 'a b'\nf")).toEqual([["cat", "<<<", "a b"], ["f"]]);
    });
  });

  describe("gives up on text it cannot parse", () => {
    it.each<[string, string]>([
      ["an unterminated single quote", "echo 'abc"],
      ["an unterminated double quote", 'echo "abc'],
      ["an unterminated ANSI-C quote", "echo $'abc"],
      ["an unterminated substitution", "echo $(abc"],
      ["an unterminated backtick", "echo `abc"],
      ["a heredoc with no delimiter line", "cat <<EOF\nbody"],
      ["a heredoc with no body at all", "cat <<EOF"],
      ["a heredoc with no delimiter word", "cat <<"],
      ["nesting past the depth bound", "$(".repeat(40) + "a" + ")".repeat(40)],
    ])("%s", (_name, text) => {
      expect(simpleCommands(text)).toBeUndefined();
    });
  });

  it("stays linear on a long command", () => {
    const text = `${"echo 'a b' \"c d\" $(e f) # g\n".repeat(5_000)}`;
    const start = performance.now();
    expect(simpleCommands(text)!.length).toBeGreaterThan(5_000);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

describe("shellCommands: the heredoc a command reads as its stdin", () => {
  it("attaches the body of a quoted heredoc to the command that holds the operator", () => {
    expect(shellCommands("bash <<'EOF'\nrun a; b\nEOF\nf")).toEqual([{ words: ["bash"], stdin: "run a; b" }, { words: ["f"] }]);
  });
  it("attaches an unquoted body too, and the last heredoc of a command is its stdin", () => {
    expect(shellCommands("cat <<A <<'B'\none\nA\ntwo\nB")).toEqual([{ words: ["cat"], stdin: "two" }]);
    expect(shellCommands("zsh <<EOF\nbody $(x y)\nEOF")).toEqual(expect.arrayContaining([{ words: ["zsh"], stdin: "body $(x y)" }, { words: ["x", "y"] }]));
  });
  it("keeps the words and leaves stdin off a command with no heredoc, as simpleCommands returns the words only", () => {
    expect(shellCommands("a b; c")).toEqual([{ words: ["a", "b"] }, { words: ["c"] }]);
    expect(simpleCommands("bash <<'EOF'\nx\nEOF")).toEqual([["bash"]]);
  });
  it("joins a body's lines with newlines, tabs stripped for <<-", () => {
    expect(shellCommands("sh <<-'EOF'\n\ta\n\tb\n\tEOF")).toEqual([{ words: ["sh"], stdin: "a\nb" }]);
  });
});

// Issue #324 review: a UI-test run that is backgrounded returns at once, so the decision whether a `&` backgrounds a command is the tokenizer's: the
// command followed by an `&` separator, or in a pipeline, group or subshell that is, up to the last `;` or newline.
describe("shellCommands: which commands a & backgrounds", () => {
  const backgrounded = (text: string): string[] => shellCommands(text)!.filter((c) => c.background).map((c) => c.words.join(" "));

  it.each<[string, string, string[]]>([
    ["a trailing &", "a x &", ["a x"]],
    ["a & before another command", "a x & b y", ["a x"]],
    ["each & backgrounds the command before it", "a & b & c", ["a", "b"]],
    ["a & after a redirect", "a x > f 2>&1 & echo $!", ["a x"]],
    ["a pipeline", "a | b | c &", ["a", "b", "c"]],
    ["an and-or list", "a && b || c &", ["a", "b", "c"]],
    ["a command in a subshell that backgrounds itself", "(a x &)", ["a x"]],
    ["a subshell that is backgrounded", "(a x; b) &", ["a x", "b"]],
    ["a group that backgrounds a command", "{ a x & }", ["{ a x"]],
    ["a group that is backgrounded", "{ a x; b; } &", ["{ a x", "b", "}"]],
    ["only the last statement before the &", "a; b &", ["b"]],
    ["a newline ends the statement", "a\nb &", ["b"]],
    ["a & ends the statement", "a & b", ["a"]],
    ["a & inside a subshell does not reach before it", "a; (b &); c", ["b"]],
  ])("marks %s", (_name, text, expected) => {
    expect(backgrounded(text)).toEqual(expected);
  });

  it.each<[string, string]>([
    ["no &", "a x"],
    ["&&", "a && b"],
    ["a & in a redirect", "a 2>&1 && b"],
    ["&>", "a &>f"],
    ["|&", "a |& b"],
    ["a quoted &", "a 'x & y'"],
    ["a & in a heredoc body", "cat <<'EOF'\na &\nEOF"],
    ["a command before a ; that ends the statement", "a x; b &"],
  ])("marks nothing for %s", (_name, text) => {
    const marked = backgrounded(text);
    expect(marked.filter((w) => w.startsWith("a x") || w === "a")).toEqual([]);
  });
});

// Issue #324 review: a `;` inside a compound command (`if`, `for`, `while`, `until`, `case`, `{ }`, a function body) ended the statement, so a lone `&`
// after its closer marked only the last inner command. The closer now restores the statement to its opener, and a function whose call is backgrounded
// takes its body with it.
describe("shellCommands: compound commands, functions, coproc and process substitution", () => {
  const marked = (text: string): string[] => shellCommands(text)!.filter((c) => c.background).map((c) => c.words.join(" "));

  it.each<[string, string, string[]]>([
    ["if", "if c; then a x; fi &", ["if c", "then a x", "fi"]],
    ["if with else", "if c; then a x; else b y; fi &", ["if c", "then a x", "else b y", "fi"]],
    ["for with redirects on done", "for s in A B; do a x; done > log 2>&1 &", ["for s in A B", "do a x", "done"]],
    ["while", "while c; do a x; done &", ["while c", "do a x", "done"]],
    ["until", "until c; do a x; done &", ["until c", "do a x", "done"]],
    ["case", "case $v in p) a x ;; esac &", ["case $v in p", "a x", "esac"]],
    ["a nested compound", "if c; then for s in A; do a x; done; fi &", ["if c", "then for s in A", "do a x", "done", "fi"]],
    ["after an and-or list", "cd /w && if c; then a x; fi &", ["cd /w", "if c", "then a x", "fi"]],
    ["a pipeline into a group", "a x | { cat; } &", ["a x", "{ cat", "}"]],
    ["a pipeline into a subshell", "a x | (cat) &", ["a x", "cat"]],
    ["a compound after a statement", "z; if c; then a x; fi &", ["if c", "then a x", "fi"]],
  ])("a trailing & after %s marks everything back to its opener", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ["a foreground if, then a backgrounded command", "if c; then a x; fi; b &", ["b"]],
    ["a compound that is not backgrounded", "if c; then a x; fi", []],
    ["a for loop with a command after it", "for s in A; do a x; done; echo hi", []],
    ["a backgrounded command before a compound", "b & if c; then a x; fi", ["b"]],
    ["the word fi as an argument", "echo fi &", ["echo fi"]],
  ])("is exact for %s", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ["a backgrounded call of a function", "f() { a x; }; f &", ["{ a x", "}", "f"]],
    ["the function keyword", "function f { a x; }; f &", ["function f { a x", "}", "f"]],
    ["a call in a backgrounded pipeline", "f() { a x; }; f | tee log &", ["{ a x", "}", "f", "tee log"]],
    ["a call with arguments", "f() { a x; }; f one two &", ["{ a x", "}", "f one two"]],
    ["a function that is defined but called in the foreground", "f() { a x; }; f", []],
    ["a function that is never called", "f() { a x; }", []],
    ["another function's call", "f() { a x; }; g &", ["g"]],
  ])("takes a function body with its backgrounded call: %s", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ["coproc", "coproc a x", ["coproc a x"]],
    ["a named coproc", "coproc NAME a x", ["coproc NAME a x"]],
    ["a coproc group", "coproc { a x; }", ["coproc { a x"]],
    ["a coproc is not a word inside another command", "echo coproc", []],
  ])("marks %s as backgrounded", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ["an output process substitution", "tee >(a x)", ["a x"]],
    ["an input process substitution", "cat <(a x)", ["a x"]],
    ["two of them", "diff <(a x) <(b y)", ["a x", "b y"]],
    ["a substitution with several commands", "tee >(a x; b y)", ["a x", "b y"]],
    ["a plain subshell next to a redirect is not one", "(a x) > f", []],
    ["a here-string and a subshell", "cat <<< x; (a x)", []],
  ])("marks the commands inside %s as backgrounded", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  // Issue #324 review: a newline right after `|`, `&&`, `||` or `|&` continues the statement (the shell waits for the rest of it), so an `&` on the next
  // line still backgrounds the command before the operator.
  it.each<[string, string, string[]]>([
    ["a pipe", "a x |\n  tee log &", ["a x", "tee log"]],
    ["a pipe of both streams", "a x |&\n  tee log &", ["a x", "tee log"]],
    ["&&", "a x &&\n  echo done &", ["a x", "echo done"]],
    ["||", "a x ||\n  b y &", ["a x", "b y"]],
    ["a redirect before the pipe", "a x 2>&1 |\n  b > out.log &", ["a x", "b"]],
    ["blank lines and a comment between", "a x |\n\n  # note\n  tee log &", ["a x", "tee log"]],
    ["several continued lines", "a x |\n  b |\n  c &", ["a x", "b", "c"]],
  ])("a trailing & continues over a newline after %s", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  it.each<[string, string, string[]]>([
    ["a continued pipeline, then a new statement", "a x |\n  tee log\nb &", ["b"]],
    ["a continued and-or list, then a new statement", "a x &&\n  b y\nc &", ["c"]],
    ["a newline with no operator before it", "a x\n  tee log &", ["tee log"]],
    ["a newline before the operator", "a x\n| tee log &", ["tee log"]],
    ["a continued pipeline that is not backgrounded", "a x |\n  tee log", []],
  ])("a newline still ends the statement otherwise: %s", (_name, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });

  it("still marks a statement's own & as before", () => {
    expect(marked("a x & b y")).toEqual(["a x"]);
    expect(marked("(a x; b) &")).toEqual(["a x", "b"]);
  });
});
