import { execSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { shellQuote } from "../src/shell-quote.js";

describe("shellQuote", () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("preserves spaces", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes via close-reopen", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("leaves shell metacharacters literal so the shell does not expand them", () => {
    expect(shellQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
    expect(shellQuote("$VAR")).toBe("'$VAR'");
    expect(shellQuote("`backtick`")).toBe("'`backtick`'");
    expect(shellQuote("a;b|c&d")).toBe("'a;b|c&d'");
  });

  it("handles an empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles a string of only single quotes", () => {
    expect(shellQuote("'")).toBe(`''\\'''`);
  });

  it("survives a real shell round-trip with spaces, quotes, and meta chars", () => {
    // End-to-end check: the output must, when interpolated into a shell
    // command, deliver the original string byte-for-byte to the program.
    const cases = [
      "plain",
      "with spaces",
      "it's a trap",
      "$VAR not expanded",
      "back`tick`",
      "semi;colon",
      "a|b&c",
      "*glob*",
    ];
    for (const s of cases) {
      const out = execSync(`printf %s ${shellQuote(s)}`, { encoding: "utf-8" });
      expect(out).toBe(s);
    }
  });
});
