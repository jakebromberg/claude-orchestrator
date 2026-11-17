import { describe, it, expect } from "vitest";
import { simpleCommands } from "../src/shell-commands.js";

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
    ["a redirect that holds a &", "a 2>&1 | b", [["a", "2>&1"], ["b"]]],
    ["&> and >&", "a &> f; b >&2", [["a", "&>", "f"], ["b", ">&2"]]],
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
      expect(simpleCommands("cat <<'EOF' > out.txt && g\nbody\nEOF")).toEqual([["cat", ">", "out.txt"], ["g"]]);
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
