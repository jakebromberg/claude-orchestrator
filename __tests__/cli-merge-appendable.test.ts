import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  parseMergeAppendableArgs,
  runMergeDriver,
} from "../src/cli-merge-appendable.js";

// ---------------------------------------------------------------------------
// parseMergeAppendableArgs — git driver mode
// ---------------------------------------------------------------------------

describe("parseMergeAppendableArgs — driver mode", () => {
  it("parses all required driver flags inline", () => {
    const args = parseMergeAppendableArgs([
      "--base", "/tmp/base.json",
      "--current", "/tmp/current.json",
      "--incoming", "/tmp/incoming.json",
      "--array-path", "entries",
      "--key-field", "idx",
    ]);
    expect(args).toEqual({
      mode: "driver",
      base: "/tmp/base.json",
      current: "/tmp/current.json",
      incoming: "/tmp/incoming.json",
      arrayPath: "entries",
      keyField: "idx",
    });
  });

  it("throws when --base is missing", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--current", "/tmp/cur.json",
        "--incoming", "/tmp/inc.json",
        "--array-path", "entries",
        "--key-field", "idx",
      ]),
    ).toThrow(/--base/);
  });

  it("throws when --current is missing", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "/tmp/base.json",
        "--incoming", "/tmp/inc.json",
        "--array-path", "entries",
        "--key-field", "idx",
      ]),
    ).toThrow(/--current/);
  });

  it("throws when --incoming is missing", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "/tmp/base.json",
        "--current", "/tmp/cur.json",
        "--array-path", "entries",
        "--key-field", "idx",
      ]),
    ).toThrow(/--incoming/);
  });

  it("throws when --array-path is missing and no --config", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "/tmp/base.json",
        "--current", "/tmp/cur.json",
        "--incoming", "/tmp/inc.json",
        "--key-field", "idx",
      ]),
    ).toThrow(/--array-path/);
  });

  it("throws when --key-field is missing and no --config", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "/tmp/base.json",
        "--current", "/tmp/cur.json",
        "--incoming", "/tmp/inc.json",
        "--array-path", "entries",
      ]),
    ).toThrow(/--key-field/);
  });

  it("throws on unknown flags", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "/tmp/base.json",
        "--current", "/tmp/cur.json",
        "--incoming", "/tmp/inc.json",
        "--array-path", "entries",
        "--key-field", "idx",
        "--unknown-flag",
      ]),
    ).toThrow(/Unknown argument/);
  });

  it("throws on duplicate flags", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "/tmp/base.json",
        "--base", "/tmp/base2.json",
        "--current", "/tmp/cur.json",
        "--incoming", "/tmp/inc.json",
        "--array-path", "entries",
        "--key-field", "idx",
      ]),
    ).toThrow(/--base given more than once/);
  });

  it("throws when a flag value looks like another flag", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--base", "--current",
        "--current", "/tmp/cur.json",
        "--incoming", "/tmp/inc.json",
        "--array-path", "entries",
        "--key-field", "idx",
      ]),
    ).toThrow(/--base/);
  });
});

// ---------------------------------------------------------------------------
// parseMergeAppendableArgs — resolve mode
// ---------------------------------------------------------------------------

describe("parseMergeAppendableArgs — resolve mode", () => {
  it("parses all required resolve flags", () => {
    const args = parseMergeAppendableArgs([
      "--resolve", "/repo/db/meta/_journal.json",
      "--array-path", "entries",
      "--key-field", "idx",
    ]);
    expect(args).toEqual({
      mode: "resolve",
      file: "/repo/db/meta/_journal.json",
      arrayPath: "entries",
      keyField: "idx",
      baseBranch: "main",
    });
  });

  it("accepts a custom --base-branch", () => {
    const args = parseMergeAppendableArgs([
      "--resolve", "/repo/file.json",
      "--array-path", "entries",
      "--key-field", "idx",
      "--base-branch", "develop",
    ]);
    expect(args.mode === "resolve" && args.baseBranch).toBe("develop");
  });

  it("throws when --array-path is missing in resolve mode", () => {
    expect(() =>
      parseMergeAppendableArgs([
        "--resolve", "/repo/file.json",
        "--key-field", "idx",
      ]),
    ).toThrow(/--array-path/);
  });
});

// ---------------------------------------------------------------------------
// runMergeDriver
// ---------------------------------------------------------------------------

const journalBase = JSON.stringify({
  version: "7",
  entries: [
    { idx: 0, tag: "0000_init" },
    { idx: 57, tag: "0057_prev" },
  ],
});
const journalCurrent = JSON.stringify({
  version: "7",
  entries: [
    { idx: 0, tag: "0000_init" },
    { idx: 57, tag: "0057_prev" },
    { idx: 61, tag: "0061_ours" },
  ],
});
const journalIncoming = JSON.stringify({
  version: "7",
  entries: [
    { idx: 0, tag: "0000_init" },
    { idx: 57, tag: "0057_prev" },
    { idx: 62, tag: "0062_theirs" },
  ],
});

describe("runMergeDriver", () => {
  it("reads base/current/incoming and writes merged result to current path", () => {
    const files: Record<string, string> = {
      "/tmp/base.json": journalBase,
      "/tmp/cur.json": journalCurrent,
      "/tmp/inc.json": journalIncoming,
    };
    const written: Record<string, string> = {};

    runMergeDriver(
      {
        mode: "driver",
        base: "/tmp/base.json",
        current: "/tmp/cur.json",
        incoming: "/tmp/inc.json",
        arrayPath: "entries",
        keyField: "idx",
      },
      {
        readFile: (p) => files[p]!,
        writeFile: (p, content) => { written[p] = content; },
      },
    );

    expect(written["/tmp/cur.json"]).toBeDefined();
    const result = JSON.parse(written["/tmp/cur.json"]!) as { entries: { idx: number }[] };
    expect(result.entries.map((e) => e.idx)).toEqual([0, 57, 61, 62]);
  });

  it("writes valid JSON", () => {
    const files: Record<string, string> = {
      "/tmp/base.json": journalBase,
      "/tmp/cur.json": journalCurrent,
      "/tmp/inc.json": journalIncoming,
    };
    const written: Record<string, string> = {};

    runMergeDriver(
      {
        mode: "driver",
        base: "/tmp/base.json",
        current: "/tmp/cur.json",
        incoming: "/tmp/inc.json",
        arrayPath: "entries",
        keyField: "idx",
      },
      {
        readFile: (p) => files[p]!,
        writeFile: (p, content) => { written[p] = content; },
      },
    );

    expect(() => JSON.parse(written["/tmp/cur.json"]!)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ESM safety
// ---------------------------------------------------------------------------

describe("ESM safety", () => {
  it("source contains no inline require() calls", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/cli-merge-appendable.ts", import.meta.url)),
      "utf-8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });
});
