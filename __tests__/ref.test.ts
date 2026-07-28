import { describe, it, expect } from "vitest";
import {
  refOf,
  normalizeDep,
  repoOfRef,
  encodeRefForFilename,
  decodeRefFromFilename,
  compareRef,
  compareRefString,
} from "../src/ref.js";

describe("refOf", () => {
  it("qualifies with the issue's own repo", () => {
    expect(refOf({ repo: "WXYC/lml", number: 924 })).toBe("WXYC/lml#924");
  });

  it("falls back to defaultRepo when the issue has no repo", () => {
    expect(refOf({ number: 924 }, "WXYC/lml")).toBe("WXYC/lml#924");
  });

  it("prefers the issue's own repo over defaultRepo", () => {
    expect(refOf({ repo: "WXYC/bs", number: 924 }, "WXYC/lml")).toBe("WXYC/bs#924");
  });

  it("emits a bare number when no repo is known (single-repo back-compat)", () => {
    expect(refOf({ number: 7 })).toBe("7");
  });
});

describe("normalizeDep", () => {
  const citing = { repo: "WXYC/lml", number: 5 };

  it("resolves a bare number to the citing issue's repo", () => {
    expect(normalizeDep(1, citing)).toBe("WXYC/lml#1");
  });

  it("resolves a numeric string to the citing issue's repo", () => {
    expect(normalizeDep("1", citing)).toBe("WXYC/lml#1");
  });

  it("resolves a leading-hash ref to the citing issue's repo", () => {
    expect(normalizeDep("#2", citing)).toBe("WXYC/lml#2");
  });

  it("keeps a fully-qualified cross-repo ref as-is", () => {
    expect(normalizeDep("WXYC/discogs-cache#2", citing)).toBe("WXYC/discogs-cache#2");
  });

  it("uses defaultRepo when the citing issue has no repo", () => {
    expect(normalizeDep(1, { number: 5 }, "WXYC/lml")).toBe("WXYC/lml#1");
  });

  it("emits a bare number when neither citing repo nor defaultRepo is known", () => {
    expect(normalizeDep(1, { number: 5 })).toBe("1");
  });
});

describe("repoOfRef", () => {
  it("returns the owner/repo of a qualified ref", () => {
    expect(repoOfRef("WXYC/lml#924")).toBe("WXYC/lml");
  });

  it("returns undefined for a bare-number ref", () => {
    expect(repoOfRef("924")).toBeUndefined();
  });

  it("distinguishes the same number across repos", () => {
    expect(repoOfRef("WXYC/lml#924")).not.toBe(repoOfRef("WXYC/backend#924"));
  });
});

describe("encodeRefForFilename / decodeRefFromFilename", () => {
  it("leaves a bare-number ref unchanged (preserves legacy filenames)", () => {
    expect(encodeRefForFilename("123")).toBe("123");
  });

  it("percent-encodes / and # in a qualified ref", () => {
    expect(encodeRefForFilename("WXYC/lml#924")).toBe("WXYC%2Flml%23924");
  });

  it("round-trips refs that themselves contain a percent sign", () => {
    for (const ref of ["123", "WXYC/lml#924", "a%b/c#1", "o/r#10"]) {
      expect(decodeRefFromFilename(encodeRefForFilename(ref))).toBe(ref);
    }
  });
});

describe("compareRef", () => {
  it("orders numerically within the same repo", () => {
    const a = { repo: "WXYC/lml", number: 9 };
    const b = { repo: "WXYC/lml", number: 10 };
    expect(compareRef(a, b)).toBeLessThan(0);
  });

  it("orders bare-number issues numerically, not lexically", () => {
    // "9" vs "10": numeric order must win (9 < 10), unlike string compare.
    expect(compareRef({ number: 9 }, { number: 10 })).toBeLessThan(0);
  });

  it("orders by repo first, then number", () => {
    const a = { repo: "WXYC/a", number: 100 };
    const b = { repo: "WXYC/b", number: 1 };
    expect(compareRef(a, b)).toBeLessThan(0);
  });

  it("uses defaultRepo for repo-less issues when comparing", () => {
    const a = { number: 1 };
    const b = { repo: "WXYC/lml", number: 2 };
    // defaultRepo "WXYC/lml" makes a's repo equal b's, so numeric order applies.
    expect(compareRef(a, b, "WXYC/lml")).toBeLessThan(0);
  });
});

describe("compareRefString", () => {
  it("orders numerically within the same repo (#9 before #10)", () => {
    expect(compareRefString("WXYC/lml#9", "WXYC/lml#10")).toBeLessThan(0);
  });

  it("orders bare-number refs numerically, not lexically", () => {
    expect(compareRefString("9", "10")).toBeLessThan(0);
  });

  it("orders by repo first, then number", () => {
    expect(compareRefString("WXYC/a#100", "WXYC/b#1")).toBeLessThan(0);
  });

  it("treats a bare ref as the empty repo, sorting it before any qualified ref", () => {
    expect(compareRefString("5", "WXYC/lml#1")).toBeLessThan(0);
  });

  it("is consistent with compareRef for the same refs", () => {
    expect(compareRefString("WXYC/lml#10", "WXYC/lml#2")).toBeGreaterThan(0);
    expect(compareRef({ repo: "WXYC/lml", number: 10 }, { repo: "WXYC/lml", number: 2 })).toBeGreaterThan(0);
  });
});
