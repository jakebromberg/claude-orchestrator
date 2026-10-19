import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

import { sweepDeadTemps, tempOwnerPid, writeFileAtomic } from "../src/atomic-write.js";

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

  it("round-trips the pid of the temp name it generates", () => {
    writeFileAtomic(file, "a");
    expect(written).toHaveLength(1);
    expect(tempOwnerPid(basename(written[0]))).toBe(process.pid);
  });

  it.each([
    { name: "target absent", existing: undefined, throws: false, content: "new" },
    { name: "target present", existing: "old", throws: true, content: "old" },
  ])("exclusive write, $name, leaves no temp file", ({ existing, throws, content }) => {
    if (existing !== undefined) writeFileSync(file, existing);
    const write = () => writeFileAtomic(file, "new", { exclusive: true });
    if (throws) expect(write).toThrow(expect.objectContaining({ code: "EEXIST" }));
    else write();
    expect(readFileSync(file, "utf8")).toBe(content);
    if (!throws) expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["record.json"]);
  });
});

describe("tempOwnerPid", () => {
  it.each([
    ["record.json.4242.0a1b2c3d.tmp", 4242],
    ["lastAdmit.7.ff.tmp", 7],
    ["record.json", undefined],
    ["record.json.tmp", undefined],
    ["record.json.abc.0a1b.tmp", undefined],
    ["record.json.4242.XYZ.tmp", undefined],
    ["record.json.4242.0a1b.tmp.bak", undefined],
  ])("%s -> %s", (name, pid) => {
    expect(tempOwnerPid(name)).toBe(pid);
  });
});

describe("sweepDeadTemps", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-sweep-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it.each([
    { name: "dead owner", file: "a.json.111.aa.tmp", removed: true },
    { name: "live owner", file: "a.json.222.aa.tmp", removed: false },
    { name: "no pid in the name", file: "a.json.tmp", removed: false },
    { name: "a record", file: "a.json", removed: false },
    { name: "owner pid 0", file: "a.json.0.aa.tmp", removed: false },
  ])("$name", ({ file, removed }) => {
    writeFileSync(join(dir, file), "x");
    sweepDeadTemps(dir, (pid) => pid === 222);
    expect(existsSync(join(dir, file))).toBe(!removed);
  });

  it("skips a directory that does not exist", () => {
    expect(() => sweepDeadTemps(join(dir, "missing"), () => false)).not.toThrow();
  });
});
