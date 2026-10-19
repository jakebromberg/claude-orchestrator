import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLeaseRecord, readRecordDir, readRegularFile, writeLeaseRecord } from "../src/lease-dir.js";

describe("writeLeaseRecord", () => {
  let tmp: string;
  let target: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-dir-"));
    target = join(tmp, "target");
    mkdirSync(target);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const rows: [string, (dir: string) => void, boolean][] = [
    ["an owned directory", (d) => mkdirSync(d, { mode: 0o700 }), true],
    ["a missing directory", () => {}, false],
    ["a symlinked directory", (d) => symlinkSync(target, d), false],
    ["a regular file at the directory's path", (d) => writeFileSync(d, "x"), false],
  ];

  it.each(rows)("%s", (_name, plant, written) => {
    const dir = join(tmp, "lease");
    plant(dir);
    expect(writeLeaseRecord(dir, "rec.json", "{}")).toBe(written);
    if (written) {
      expect(readFileSync(join(dir, "rec.json"), "utf8")).toBe("{}");
      expect(statSync(join(dir, "rec.json")).mode & 0o777).toBe(0o600);
    } else {
      expect(readdirSync(target)).toEqual([]);
    }
    expect(existsSync(dir)).toBe(_name !== "a missing directory");
  });

  it("passes the write options through", () => {
    const dir = join(tmp, "lease");
    mkdirSync(dir);
    writeLeaseRecord(dir, "rec.json", "{}", { mtimeMs: 5_000 });
    expect(statSync(join(dir, "rec.json")).mtimeMs).toBe(5_000);
  });
});

describe("readRecordDir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-dir-read-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });
  const uid = () => statSync(tmp).uid;
  const asForeignAfterDirCheck = () =>
    vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValueOnce(uid()).mockReturnValue(uid() + 1);
  const put = (name: string, text = "{}") => {
    mkdirSync(join(tmp, "recs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, "recs", name), text);
  };

  it.each<[string, () => void, number[]]>([
    ["a valid record", () => put("4242.json"), [4242]],
    ["a missing subdirectory", () => {}, []],
    ["a symlinked subdirectory", () => {
      mkdirSync(join(tmp, "real"));
      writeFileSync(join(tmp, "real", "4242.json"), "{}");
      symlinkSync(join(tmp, "real"), join(tmp, "recs"));
    }, []],
    ["a leading-zero stem", () => put("04242.json"), []],
    ["a non-pid stem", () => put("abc.json"), []],
    ["a writeFileAtomic temp name", () => put("4242.json.1.ab.tmp"), []],
    ["an unreadable file", () => {
      put("4242.json");
      chmodSync(join(tmp, "recs", "4242.json"), 0o000);
      // root reads a mode-0 file, so the row only holds for other users
      if (process.getuid?.() === 0) rmSync(join(tmp, "recs", "4242.json"));
    }, []],
    ["a symlinked entry to a valid record elsewhere", () => {
      put("1.json");
      rmSync(join(tmp, "recs", "1.json"));
      writeFileSync(join(tmp, "elsewhere.json"), "{}");
      symlinkSync(join(tmp, "elsewhere.json"), join(tmp, "recs", "4242.json"));
    }, []],
    ["a FIFO entry, without blocking", () => {
      mkdirSync(join(tmp, "recs"), { mode: 0o700 });
      execFileSync("mkfifo", [join(tmp, "recs", "4242.json")]);
    }, []],
    ["a directory entry", () => {
      mkdirSync(join(tmp, "recs", "4242.json"), { recursive: true, mode: 0o700 });
    }, []],
    ["a foreign-owned file", () => { put("4242.json"); asForeignAfterDirCheck(); }, []],
    ["a foreign-owned subdirectory", () => {
      put("4242.json");
      vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValue(uid() + 1);
    }, []],
    ["a regular file beside a symlinked one", () => {
      put("4242.json");
      writeFileSync(join(tmp, "elsewhere.json"), "{}");
      symlinkSync(join(tmp, "elsewhere.json"), join(tmp, "recs", "4243.json"));
    }, [4242]],
  ])("%s", (_n, plant, stems) => {
    plant();
    const before = readdirSync(tmp).sort();
    const got = readRecordDir(tmp, "recs");
    expect(got.map((r) => r.stem)).toEqual(stems);
    for (const r of got) expect(r).toMatchObject({ text: "{}", mtimeMs: expect.any(Number) });
    expect(readdirSync(tmp).sort()).toEqual(before);
  });
});

// A FIFO row would hang the run if the reader regressed; those rows run in a killable child in lease-fifo-readers.test.ts.
describe("readLeaseRecord and readRegularFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-dir-record-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const rows: [string, () => void, boolean][] = [
    ["a regular file", () => writeFileSync(join(tmp, "rec.json"), "BODY"), true],
    ["a missing file", () => {}, false],
    ["a symlink to a regular file", () => {
      writeFileSync(join(tmp, "elsewhere"), "BODY");
      symlinkSync(join(tmp, "elsewhere"), join(tmp, "rec.json"));
    }, false],
    ["a directory", () => mkdirSync(join(tmp, "rec.json")), false],
    ["a foreign-owned file", () => {
      writeFileSync(join(tmp, "rec.json"), "BODY");
      vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValue(statSync(tmp).uid + 1);
    }, false],
  ];

  it.each(rows)("readLeaseRecord: %s", (_n, plant, read) => {
    plant();
    const got = readLeaseRecord(tmp, "rec.json");
    if (read) expect(got).toEqual({ text: "BODY", mtimeMs: expect.any(Number) });
    else expect(got).toBeUndefined();
  });

  it("readRegularFile follows a symlink, as an explicit file may be one on purpose", () => {
    writeFileSync(join(tmp, "elsewhere"), "BODY");
    symlinkSync(join(tmp, "elsewhere"), join(tmp, "link"));
    expect(readRegularFile(join(tmp, "link"))).toBe("BODY");
  });

  it.each<[string, () => void]>([
    ["a missing file", () => {}],
    ["a directory", () => mkdirSync(join(tmp, "rec.json"))],
  ])("readRegularFile throws for %s", (_n, plant) => {
    plant();
    expect(() => readRegularFile(join(tmp, "rec.json"))).toThrow();
  });
});
