import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const failRename = vi.hoisted(() => ({ on: false }));
const written = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (p: string, ...rest: unknown[]) => {
      written.push(p);
      return (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest);
    },
    renameSync: (a: string, b: string) => {
      if (failRename.on) throw new Error("rename failed");
      actual.renameSync(a, b);
    },
  };
});

import { writeFileAtomic } from "../src/atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-write-"));
    file = join(dir, "record.json");
    failRename.on = false;
    written.length = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it.each([
    { name: "default mode 0600", options: undefined, mode: 0o600, mtimeMs: undefined },
    { name: "explicit mode", options: { mode: 0o640 }, mode: 0o640, mtimeMs: undefined },
    { name: "mtime applied", options: { mtimeMs: 1_700_000_000_000 }, mode: 0o600, mtimeMs: 1_700_000_000_000 },
  ])("$name, leaving no temp file", ({ options, mode, mtimeMs }) => {
    writeFileAtomic(file, "new", options);
    expect(readFileSync(file, "utf8")).toBe("new");
    expect(statSync(file).mode & 0o777).toBe(mode);
    if (mtimeMs !== undefined) expect(statSync(file).mtimeMs).toBe(mtimeMs);
    expect(readdirSync(dir)).toEqual(["record.json"]);
  });

  it.each([{ options: undefined }, { options: { mtimeMs: 1_700_000_000_000 } }])(
    "keeps the previous content and removes the temp file when the rename fails ($options)",
    ({ options }) => {
      writeFileSync(file, "old");
      written.length = 0;
      failRename.on = true;
      expect(() => writeFileAtomic(file, "new", options)).toThrow("rename failed");
      expect(readFileSync(file, "utf8")).toBe("old");
      expect(readdirSync(dir)).toEqual(["record.json"]);
    },
  );

  it("never shares a temp name between two writes of one target", () => {
    writeFileAtomic(file, "a");
    writeFileAtomic(file, "b");
    expect(written).toHaveLength(2);
    expect(new Set(written).size).toBe(2);
    for (const name of written) expect(name).toMatch(new RegExp(`^${file.replace(/\./g, "\\.")}\\.${process.pid}\\.[0-9a-f]+\\.tmp$`));
  });
});
