import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLockOnce } from "../src/file-lock.js";

describe("tryLockOnce", () => {
  let tmp: string;
  let lockFile: string;
  const staleAfterMs = 10_000;

  const ageLock = (ms: number): void => {
    const t = (Date.now() - ms) / 1000;
    utimesSync(lockFile, t, t);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "file-lock-"));
    lockFile = join(tmp, ".mutex");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("creates the lock and removes it on release", () => {
    const lock = tryLockOnce(lockFile, { staleAfterMs });
    expect(lock).not.toBeNull();
    expect(existsSync(lockFile)).toBe(true);
    lock!.release();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("returns null without throwing or waiting while a fresh lock is held", () => {
    const first = tryLockOnce(lockFile, { staleAfterMs });
    const started = Date.now();
    expect(tryLockOnce(lockFile, { staleAfterMs })).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    first!.release();
  });

  it.each([
    ["an empty lock (holder killed between create and write)", ""],
    ["a lock naming a recycled live PID", String(process.pid)],
  ])("reaps %s once it is older than staleAfterMs", (_name, contents) => {
    writeFileSync(lockFile, contents);
    ageLock(staleAfterMs + 1_000);
    expect(tryLockOnce(lockFile, { staleAfterMs })).not.toBeNull();
    expect(readdirSync(tmp)).toEqual([".mutex"]);
  });

  it("keeps a lock younger than staleAfterMs", () => {
    writeFileSync(lockFile, "");
    ageLock(staleAfterMs - 5_000);
    expect(tryLockOnce(lockFile, { staleAfterMs })).toBeNull();
  });

  it("lets only one of two reapers of the same stale lock win", () => {
    writeFileSync(lockFile, "");
    ageLock(staleAfterMs + 1_000);
    const winner = tryLockOnce(lockFile, { staleAfterMs });
    const loser = tryLockOnce(lockFile, { staleAfterMs });
    expect(winner).not.toBeNull();
    expect(loser).toBeNull();
    expect(statSync(lockFile).size).toBeGreaterThan(0);
  });

  it("judges staleness by the injected clock", () => {
    writeFileSync(lockFile, "");
    expect(tryLockOnce(lockFile, { staleAfterMs, now: () => Date.now() + staleAfterMs + 1_000 })).not.toBeNull();
  });
});
