import { describe, it, expect } from "vitest";
import { interpolate } from "../src/interpolate.js";

describe("interpolate", () => {
  it("replaces a single variable", () => {
    expect(interpolate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("replaces multiple distinct variables", () => {
    const result = interpolate("{{a}} and {{b}}", { a: "X", b: "Y" });
    expect(result).toBe("X and Y");
  });

  it("replaces the same variable appearing multiple times", () => {
    const result = interpolate("{{x}} + {{x}}", { x: "1" });
    expect(result).toBe("1 + 1");
  });

  it("returns the template unchanged when there are no placeholders", () => {
    expect(interpolate("no placeholders here", { a: "1" })).toBe("no placeholders here");
  });

  it("returns the template unchanged when vars is empty", () => {
    expect(interpolate("{{a}}", {})).toBe("{{a}}");
  });

  it("leaves unmatched placeholders intact", () => {
    expect(interpolate("{{known}} and {{unknown}}", { known: "yes" }))
      .toBe("yes and {{unknown}}");
  });

  it("handles empty string values", () => {
    expect(interpolate("pre-{{x}}-post", { x: "" })).toBe("pre--post");
  });

  it("handles an empty template", () => {
    expect(interpolate("", { a: "1" })).toBe("");
  });

  it("handles variables with special regex characters in values", () => {
    expect(interpolate("path: {{dir}}", { dir: "/foo/bar$1" })).toBe("path: /foo/bar$1");
  });

  it("is case-sensitive for variable names", () => {
    expect(interpolate("{{Name}} {{name}}", { name: "lower" })).toBe("{{Name}} lower");
  });

  it("handles whitespace around variable names", () => {
    // Only exact match — spaces inside braces are part of the name
    expect(interpolate("{{ name }}", { name: "val" })).toBe("{{ name }}");
  });
});
