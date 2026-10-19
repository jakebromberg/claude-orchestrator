import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRecordDir, writeLeaseRecord } from "../src/lease-dir.js";

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
    rmSync(tmp, { recursive: true, force: true });
  });
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
    ["an unreadable file", () => { put("4242.json"); chmodSync(join(tmp, "recs", "4242.json"), 0o000); }, []],
  ])("%s", (_n, plant, stems) => {
    plant();
    const before = readdirSync(tmp).sort();
    const got = readRecordDir(tmp, "recs");
    expect(got.map((r) => r.stem)).toEqual(stems);
    for (const r of got) expect(r).toMatchObject({ text: "{}", mtimeMs: expect.any(Number) });
    expect(readdirSync(tmp).sort()).toEqual(before);
  });
});
