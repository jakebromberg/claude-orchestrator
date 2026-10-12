import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, fstatSync, lutimesSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLockOnce, type FileLock } from "../src/file-lock.js";

// file-lock binds node:fs through named imports, so the rows that inject an I/O
// failure mock the module (as claude-auth-wiring.test.ts does). Until a row
// queues a failure, both mocks make the real calls.
const fault = vi.hoisted(() => ({ writeSync: vi.fn(), lstatSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: fault.writeSync,
  lstatSync: fault.lstatSync,
}));
const { lstatSync: realLstatSync, writeSync: realWriteSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
const ioError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

describe("tryLockOnce", () => {
  let tmp: string;
  let lockFile: string;
  const staleAfterMs = 10_000;

  const setMtime = (file: string, ms: number): void => lutimesSync(file, ms / 1000, ms / 1000);
  const ageLock = (ms: number, file = lockFile): void => setMtime(file, Date.now() - ms);

  beforeEach(() => {
    // Drop any failure a failed row queued but never consumed.
    fault.writeSync.mockReset().mockImplementation(realWriteSync);
    fault.lstatSync.mockReset().mockImplementation(realLstatSync);
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
    ["an empty lock (holder killed between create and write)", () => writeFileSync(lockFile, "")],
    ["a lock naming a recycled live PID", () => writeFileSync(lockFile, String(process.pid))],
    ["a dangling symlink", () => symlinkSync(join(tmp, "gone"), lockFile)],
  ])("reaps %s once it is older than staleAfterMs", (_name, setUp) => {
    setUp();
    ageLock(staleAfterMs + 1_000);
    expect(tryLockOnce(lockFile, { staleAfterMs })).not.toBeNull();
    expect(readdirSync(tmp)).toEqual([".mutex"]);
  });

  // mtime offsets in whole milliseconds from the injected clock's reading. Each
  // mtime sits half a millisecond into its millisecond, as real writes do, so the
  // boundary rows pin the floor and not utimes' rounding.
  it.each([
    ["keeps a lock staleAfterMs old", -staleAfterMs, false],
    ["reaps a lock staleAfterMs + 1 ms old", -(staleAfterMs + 1), true],
    ["keeps a lock dated 2 ms ahead (the clock stepped back a little)", 2, false],
    ["keeps a lock dated staleAfterMs ahead", staleAfterMs, false],
    ["reaps a lock dated staleAfterMs + 1 ms ahead", staleAfterMs + 1, true],
    ["reaps a lock dated an hour ahead", 3_600_000, true],
  ])("%s", (_name, mtimeOffsetMs, reaped) => {
    const clock = Date.now() - 60_000;
    writeFileSync(lockFile, "");
    setMtime(lockFile, clock + mtimeOffsetMs + 0.5);
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

  // Each row's event runs inside the reaper's clock reading under its turn, just
  // after its lstat judged the lock stale. ext4 often gives a new file the inode
  // number just freed; APFS does not, so one row fakes that.
  const takeOverStalledReap = (): void => {
    ageLock(staleAfterMs + 1_000, `${lockFile}.reap`);
    expect(tryLockOnce(lockFile, { staleAfterMs })).not.toBeNull();
  };
  it.each<[string, (stale: Stats) => void]>([
    ["the reaper stalls past staleAfterMs and another caller reaps its turn and the lock, and takes it", takeOverStalledReap],
    ["the same happens and the new lock reuses the stale lock's inode number", ({ dev, ino }) => {
      takeOverStalledReap();
      fault.lstatSync.mockImplementationOnce((file: string) => Object.assign(realLstatSync(file), { dev, ino }));
    }],
    ["a late release removes the lock and a new caller takes it just after the reaper's last lstat", () => {
      rmSync(lockFile);
      fault.lstatSync.mockImplementationOnce((file: string) => {
        const gone = realLstatSync(file, { throwIfNoEntry: false });
        expect(tryLockOnce(lockFile, { staleAfterMs })).not.toBeNull();
        return gone;
      });
    }],
  ])("leaves exactly one holder of a stale lock when %s", (_name, midReap) => {
    writeFileSync(lockFile, "");
    ageLock(staleAfterMs + 1_000);
    const stale = realLstatSync(lockFile);
    let ran = false;
    const now = (): number => {
      if (!ran && existsSync(`${lockFile}.reap`)) {
        ran = true;
        midReap(stale);
      }
      return Date.now();
    };
    expect(tryLockOnce(lockFile, { staleAfterMs, now })).toBeNull();
    expect(existsSync(lockFile)).toBe(true);
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

  it("throws, and closes and removes the new lock file, when writing its token fails", () => {
    let fd = -1;
    fault.writeSync.mockImplementationOnce((written: number) => {
      fd = written;
      throw ioError("ENOSPC");
    });
    expect(() => tryLockOnce(lockFile, { staleAfterMs })).toThrow(/ENOSPC/);
    expect(() => fstatSync(fd)).toThrow(/EBADF/);
    expect(existsSync(lockFile)).toBe(false);
  });

  it.each([
    ["creating the lock in a missing directory", "ENOENT", () => (lockFile = join(tmp, "missing", ".mutex"))],
    ["checking a held lock's age", "EIO", () => {
      writeFileSync(lockFile, "");
      fault.lstatSync.mockImplementationOnce(() => { throw ioError("EIO"); });
    }],
  ])("throws an I/O error other than EEXIST from %s (%s)", (_name, code, setUp) => {
    setUp();
    expect(() => tryLockOnce(lockFile, { staleAfterMs })).toThrow(code);
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
