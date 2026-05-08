import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  getNestedArray,
  setNestedArray,
  extractJsonObjects,
  parseConflictSections,
  mergeJsonArrays,
  mergeJsonDocuments,
  resolveConflict,
} from "../src/merge-appendable.js";

// ---------------------------------------------------------------------------
// getNestedArray
// ---------------------------------------------------------------------------

describe("getNestedArray", () => {
  it("returns a top-level array", () => {
    const doc = { entries: [{ idx: 0 }, { idx: 1 }] };
    expect(getNestedArray(doc, "entries")).toEqual([{ idx: 0 }, { idx: 1 }]);
  });

  it("navigates dot-separated paths", () => {
    const doc = { meta: { entries: [{ idx: 0 }] } };
    expect(getNestedArray(doc, "meta.entries")).toEqual([{ idx: 0 }]);
  });

  it("throws when path does not point to an array", () => {
    const doc = { entries: "not an array" };
    expect(() => getNestedArray(doc, "entries")).toThrow(/array/);
  });

  it("throws when an intermediate key is missing", () => {
    const doc = { other: {} };
    expect(() => getNestedArray(doc, "meta.entries")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// setNestedArray
// ---------------------------------------------------------------------------

describe("setNestedArray", () => {
  it("replaces a top-level array, preserving other fields", () => {
    const doc = { version: "7", entries: [{ idx: 0 }] };
    const result = setNestedArray(doc, "entries", [{ idx: 0 }, { idx: 1 }]);
    expect(result).toEqual({ version: "7", entries: [{ idx: 0 }, { idx: 1 }] });
  });

  it("replaces a nested array", () => {
    const doc = { meta: { dialect: "pg", entries: [{ idx: 0 }] }, version: "7" };
    const result = setNestedArray(doc, "meta.entries", [{ idx: 0 }, { idx: 1 }]);
    expect(result).toEqual({
      version: "7",
      meta: { dialect: "pg", entries: [{ idx: 0 }, { idx: 1 }] },
    });
  });

  it("does not mutate the original document", () => {
    const doc = { entries: [{ idx: 0 }] };
    setNestedArray(doc, "entries", [{ idx: 0 }, { idx: 1 }]);
    expect(doc.entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// extractJsonObjects
// ---------------------------------------------------------------------------

describe("extractJsonObjects", () => {
  it("extracts a single complete object", () => {
    const text = `  { "idx": 61, "tag": "0061_foo" }  `;
    expect(extractJsonObjects(text)).toEqual([{ idx: 61, tag: "0061_foo" }]);
  });

  it("extracts multiple objects from a comma-separated list", () => {
    const text = `{ "idx": 61, "tag": "a" },\n  { "idx": 62, "tag": "b" }`;
    const objs = extractJsonObjects(text);
    expect(objs).toHaveLength(2);
    expect(objs[0]).toEqual({ idx: 61, tag: "a" });
    expect(objs[1]).toEqual({ idx: 62, tag: "b" });
  });

  it("skips partial/broken objects and returns only parseable ones", () => {
    // Simulate a conflict that broke an object mid-way
    const text = `    { "idx": 62, "tag": "b" }\n  ]\n}`;
    const objs = extractJsonObjects(text);
    expect(objs).toHaveLength(1);
    expect(objs[0]).toEqual({ idx: 62, tag: "b" });
  });

  it("returns empty array when no objects are present", () => {
    expect(extractJsonObjects("  ]\n}\n")).toEqual([]);
  });

  it("handles multi-line objects", () => {
    const text = `{\n  "idx": 61,\n  "tag": "0061_foo",\n  "breakpoints": true\n}`;
    const objs = extractJsonObjects(text);
    expect(objs).toHaveLength(1);
    expect(objs[0]).toEqual({ idx: 61, tag: "0061_foo", breakpoints: true });
  });
});

// ---------------------------------------------------------------------------
// parseConflictSections
// ---------------------------------------------------------------------------

describe("parseConflictSections", () => {
  it("returns null when there are no conflict markers", () => {
    expect(parseConflictSections('{"entries": []}')).toBeNull();
  });

  it("returns ours and theirs sections from a conflict block", () => {
    const content = [
      "<<<<<<< HEAD",
      '    {"idx": 61, "tag": "0061_a"}',
      "=======",
      '    {"idx": 62, "tag": "0062_b"}',
      ">>>>>>> branch",
    ].join("\n");
    const sections = parseConflictSections(content);
    expect(sections).not.toBeNull();
    expect(sections!.ours).toContain('"idx": 61');
    expect(sections!.theirs).toContain('"idx": 62');
  });

  it("ours does not contain the marker lines themselves", () => {
    const content = "<<<<<<< HEAD\n  line\n=======\n  other\n>>>>>>> x";
    const sections = parseConflictSections(content)!;
    expect(sections.ours).not.toMatch(/^<{7}/m);
    expect(sections.ours).not.toMatch(/^={7}/m);
    expect(sections.theirs).not.toMatch(/^={7}/m);
    expect(sections.theirs).not.toMatch(/^>{7}/m);
  });
});

// ---------------------------------------------------------------------------
// mergeJsonArrays
// ---------------------------------------------------------------------------

describe("mergeJsonArrays", () => {
  const base = [{ idx: 0 }, { idx: 57 }];
  const current = [{ idx: 0 }, { idx: 57 }, { idx: 61 }];
  const incoming = [{ idx: 0 }, { idx: 57 }, { idx: 62 }];

  it("merges by keyField with no collision", () => {
    const result = mergeJsonArrays(base, current, incoming, "idx");
    expect(result.map((e) => e.idx)).toEqual([0, 57, 61, 62]);
  });

  it("sorts entries by keyField numerically", () => {
    const result = mergeJsonArrays(
      [{ idx: 0 }],
      [{ idx: 0 }, { idx: 10 }],
      [{ idx: 0 }, { idx: 9 }],
      "idx",
    );
    expect(result.map((e) => e.idx)).toEqual([0, 9, 10]);
  });

  it("sorts string keyField values lexicographically", () => {
    const result = mergeJsonArrays(
      [{ name: "a" }],
      [{ name: "a" }, { name: "c" }],
      [{ name: "a" }, { name: "b" }],
      "name",
    );
    expect(result.map((e) => e.name)).toEqual(["a", "b", "c"]);
  });

  it("throws on a genuine keyField collision between ours and theirs", () => {
    expect(() =>
      mergeJsonArrays(
        [{ idx: 0 }],
        [{ idx: 0 }, { idx: 61, tag: "a" }],
        [{ idx: 0 }, { idx: 61, tag: "b" }],
        "idx",
      ),
    ).toThrow(/collision/i);
  });

  it("handles an empty base", () => {
    const result = mergeJsonArrays(
      [],
      [{ idx: 1 }],
      [{ idx: 2 }],
      "idx",
    );
    expect(result.map((e) => e.idx)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// mergeJsonDocuments — git driver mode
// ---------------------------------------------------------------------------

const drizzleBase = JSON.stringify({
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
    { idx: 57, version: "6", when: 1701000000000, tag: "0057_feature", breakpoints: true },
  ],
});

const drizzleCurrent = JSON.stringify({
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
    { idx: 57, version: "6", when: 1701000000000, tag: "0057_feature", breakpoints: true },
    { idx: 61, version: "6", when: 1702000000000, tag: "0061_new", breakpoints: true },
  ],
});

const drizzleIncoming = JSON.stringify({
  version: "7",
  dialect: "postgresql",
  entries: [
    { idx: 0, version: "6", when: 1700000000000, tag: "0000_init", breakpoints: true },
    { idx: 57, version: "6", when: 1701000000000, tag: "0057_feature", breakpoints: true },
    { idx: 62, version: "6", when: 1702000000001, tag: "0062_other", breakpoints: true },
  ],
});

describe("mergeJsonDocuments", () => {
  it("merges two diverged journal files sharing a common base", () => {
    const result = mergeJsonDocuments(drizzleBase, drizzleCurrent, drizzleIncoming, {
      arrayPath: "entries",
      keyField: "idx",
    });
    const parsed = JSON.parse(result) as { version: string; entries: { idx: number }[] };
    expect(parsed.version).toBe("7");
    expect(parsed.entries.map((e) => e.idx)).toEqual([0, 57, 61, 62]);
  });

  it("preserves top-level document fields other than the array", () => {
    const result = mergeJsonDocuments(drizzleBase, drizzleCurrent, drizzleIncoming, {
      arrayPath: "entries",
      keyField: "idx",
    });
    const parsed = JSON.parse(result) as { dialect: string };
    expect(parsed.dialect).toBe("postgresql");
  });

  it("returns valid JSON", () => {
    const result = mergeJsonDocuments(drizzleBase, drizzleCurrent, drizzleIncoming, {
      arrayPath: "entries",
      keyField: "idx",
    });
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("throws when ours and theirs each add the same key", () => {
    const collision = JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [
        { idx: 0 },
        { idx: 57 },
        { idx: 61, tag: "0061_collision" },
      ],
    });
    expect(() =>
      mergeJsonDocuments(drizzleBase, collision, collision, {
        arrayPath: "entries",
        keyField: "idx",
      }),
    ).toThrow(/collision/i);
  });

  it("works with dot-path arrayPath", () => {
    const toDoc = (entries: unknown[]) =>
      JSON.stringify({ meta: { dialect: "pg", entries } });
    const base = toDoc([{ idx: 0 }]);
    const current = toDoc([{ idx: 0 }, { idx: 1 }]);
    const incoming = toDoc([{ idx: 0 }, { idx: 2 }]);
    const result = mergeJsonDocuments(base, current, incoming, {
      arrayPath: "meta.entries",
      keyField: "idx",
    });
    const parsed = JSON.parse(result) as { meta: { entries: { idx: number }[] } };
    expect(parsed.meta.entries.map((e) => e.idx)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// resolveConflict — manual/post-conflict mode
// ---------------------------------------------------------------------------

describe("resolveConflict", () => {
  it("returns the content unchanged when no conflict markers are present", () => {
    const clean = JSON.stringify({ version: "7", entries: [{ idx: 0 }] }, null, 2);
    const result = resolveConflict(clean, clean, { arrayPath: "entries", keyField: "idx" });
    expect(JSON.parse(result)).toEqual(JSON.parse(clean));
  });

  it("resolves a simple conflict with one entry per side", () => {
    // Simulate a git conflict in _journal.json
    const conflictContent = [
      "{",
      '  "version": "7",',
      '  "entries": [',
      '    {"idx": 0, "tag": "0000_init"},',
      '    {"idx": 57, "tag": "0057_feat"},',
      "<<<<<<< HEAD",
      '    {"idx": 61, "tag": "0061_a"}',
      "=======",
      '    {"idx": 62, "tag": "0062_b"}',
      ">>>>>>> other-branch",
      "  ]",
      "}",
    ].join("\n");

    const baseContent = JSON.stringify({
      version: "7",
      entries: [
        { idx: 0, tag: "0000_init" },
        { idx: 57, tag: "0057_feat" },
      ],
    });

    const result = resolveConflict(conflictContent, baseContent, {
      arrayPath: "entries",
      keyField: "idx",
    });
    const parsed = JSON.parse(result) as { entries: { idx: number }[] };
    expect(parsed.entries.map((e) => e.idx)).toEqual([0, 57, 61, 62]);
  });
});

// ---------------------------------------------------------------------------
// ESM safety
// ---------------------------------------------------------------------------

describe("ESM safety", () => {
  it("source contains no inline require() calls", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/merge-appendable.ts", import.meta.url)),
      "utf-8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });
});
