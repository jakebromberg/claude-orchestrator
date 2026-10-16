import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLeaseRecord } from "../src/lease-dir.js";

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
