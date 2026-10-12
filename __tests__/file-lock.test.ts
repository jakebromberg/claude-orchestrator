import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLockOnce, type FileLock } from "../src/file-lock.js";

describe("tryLockOnce", () => {
  let tmp: string;
  let lockFile: string;
  const staleAfterMs = 10_000;

  const setMtime = (file: string, ms: number): void => utimesSync(file, ms / 1000, ms / 1000);
  const ageLock = (ms: number, file = lockFile): void => setMtime(file, Date.now() - ms);

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

  // mtime offsets from the injected clock's reading.
  it.each([
    ["keeps a lock younger than staleAfterMs", -(staleAfterMs - 5_000), false],
    ["reaps a lock older than staleAfterMs", -(staleAfterMs + 1_000), true],
    ["reaps a lock dated an hour in the future (the clock stepped back)", 3_600_000, true],
    ["keeps a lock written earlier in the clock's current millisecond", 0.5, false],
  ])("%s", (_name, mtimeOffsetMs, reaped) => {
    const clock = Date.now() - 60_000;
    writeFileSync(lockFile, "");
    setMtime(lockFile, clock + mtimeOffsetMs);
    expect(tryLockOnce(lockFile, { staleAfterMs, now: () => clock }) !== null).toBe(reaped);
  });

  // Each reading of the reaper's clock lets the next contender run inside its reap,
  // so the race the reap protocol guards against happens deterministically.
  it.each([
    ["a second reaper reaps it first", 1],
    ["a second reaper reaps it first and a third caller arrives mid-reap", 2],
  ])("leaves exactly one holder of a stale lock when %s", (_name, contenders) => {
    writeFileSync(lockFile, "");
    ageLock(staleAfterMs + 1_000);
    const others: (FileLock | null)[] = [];
    const now = (): number => {
      if (others.length < contenders) others.push(tryLockOnce(lockFile, { staleAfterMs }));
      return Date.now();
    };
    const reaper = tryLockOnce(lockFile, { staleAfterMs, now });
    expect(others).toHaveLength(contenders);
    expect([reaper, ...others].filter((l) => l !== null)).toHaveLength(1);
  });

  it.each([
    ["reaps it once the dead reaper's turn is stale", staleAfterMs + 1_000, true],
    ["waits while another reaper's turn is fresh", 0, false],
  ])("with a stale lock and a leftover reaper's turn, %s", (_name, turnAgeMs, acquired) => {
    const turn = `${lockFile}.reap`;
    writeFileSync(lockFile, "");
    writeFileSync(turn, "");
    ageLock(staleAfterMs + 1_000);
    ageLock(turnAgeMs, turn);
    expect(tryLockOnce(lockFile, { staleAfterMs }) !== null).toBe(acquired);
    if (acquired) expect(readdirSync(tmp)).toEqual([".mutex"]);
  });

  it("leaves another holder's lock in place when released after its own was reaped", () => {
    const overrun = tryLockOnce(lockFile, { staleAfterMs })!;
    const successor = tryLockOnce(lockFile, { staleAfterMs, now: () => Date.now() + staleAfterMs + 1_000 });
    expect(successor).not.toBeNull();
    overrun.release();
    expect(tryLockOnce(lockFile, { staleAfterMs })).toBeNull();
    successor!.release();
    expect(existsSync(lockFile)).toBe(false);
  });
});
