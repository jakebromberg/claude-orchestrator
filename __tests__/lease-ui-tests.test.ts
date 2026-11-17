import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, releaseHolder, tryAcquireLease, type HolderMeta, type LeaseHandle, type LeaseOptions, type LeaseRefusal } from "../src/lease.js";
import { failFsCall, plantHolder, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

// Issue #324, defect 2. A command that runs a UI-test action takes one slot of the UI-test class, capacity 1 machine-wide,
// before it waits in the heavy line, so a second run waits in its own line and never holds up an unrelated heavy command.
// The heavy class's own budget still applies to it at its normal weight.

const ui: HolderMeta = { command: "xcodebuild test -scheme App", cwd: "/work", uiTest: true };
const plain: HolderMeta = { command: "npm test", cwd: "/work" };
const isHandle = (r: LeaseHandle | LeaseRefusal): r is LeaseHandle => "leased" in r;

describe("UI-test holder class (issue #324)", () => {
  let tmp: string;
  let lease: ScriptedLease;
  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts(over);
  const names = (sub: string): string[] => (existsSync(join(lease.dir, sub)) ? readdirSync(join(lease.dir, sub)).sort() : []);
  const holder = (sub: string, id: string): Record<string, unknown> => JSON.parse(readFileSync(join(lease.dir, sub, `${id}.json`), "utf8")) as Record<string, unknown>;
  const take = async (m: HolderMeta, wait: { maxWaitMs?: number } = { maxWaitMs: 0 }, over: Partial<LeaseOptions> = {}): Promise<LeaseHandle | LeaseRefusal> => acquireLease(opts(over), m, wait);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-ui-"));
    lease = scriptedLease(join(tmp, "lease"), { policy: { heavyCeiling: 4, heavyWarning: 4 } });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("takes one UI-test slot and one heavy slot, and a release frees both", async () => {
    const h = (await take(ui)) as LeaseHandle;
    expect(h.leased).toBe(true);
    expect(names("ui-tests")).toHaveLength(1);
    expect(names("holders")).toHaveLength(1);
    expect(lease.events.filter((e) => e.type === "acquire").map((e) => e.class)).toEqual(["ui-tests", "heavy"]);
    h.release({ exitCode: 0 });
    expect(names("ui-tests")).toEqual([]);
    expect(names("holders")).toEqual([]);
    expect(lease.events.filter((e) => e.type === "release").map((e) => e.class).sort()).toEqual(["heavy", "ui-tests"]);
  });

  it("makes a second run wait in the UI-test line, while an unrelated heavy command is admitted past it with no heavy ticket held", async () => {
    const first = (await take(ui)) as LeaseHandle;
    let unrelated: LeaseHandle | null = null;
    let seen: { heavyTickets: string[]; uiTickets: string[] } | undefined;
    lease.clock.onSleep = () => {
      if (seen) return;
      unrelated = tryAcquireLease(opts(), plain);
      seen = { heavyTickets: names("waiting"), uiTickets: names("ui-tests-waiting") };
      first.release();
    };
    const second = await take(ui, { maxWaitMs: 60_000 });
    expect(isHandle(second) && second.leased).toBe(true);
    expect(unrelated).toMatchObject({ leased: true });
    expect(seen).toEqual({ heavyTickets: [], uiTickets: [expect.stringMatching(/\.json$/)] });
    expect(names("ui-tests-waiting")).toEqual([]);
    (second as LeaseHandle).release();
    unrelated!.release();
  });

  it("records the heavy weight on the heavy holder only", async () => {
    const h = (await take({ ...ui, weight: 3 * 2 ** 30 })) as LeaseHandle;
    expect(holder("holders", h.id!).weight).toBe(3 * 2 ** 30);
    const [uiId] = names("ui-tests").map((n) => n.replace(/\.json$/, ""));
    expect(holder("ui-tests", uiId!)).not.toHaveProperty("weight");
    h.release();
  });

  it("applies the heavy class's own capacity to a UI-test run: it waits in the heavy line while holding the UI-test slot", async () => {
    const heavy = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), plain)!;
    lease.clock.onSleep = () => {
      expect(names("ui-tests")).toHaveLength(1);
      expect(names("waiting")).toHaveLength(1);
      heavy.release();
    };
    const r = await take(ui, { maxWaitMs: 60_000 }, { policy: { heavyCeiling: 1, heavyWarning: 1 } });
    expect(isHandle(r) && r.leased).toBe(true);
    (r as LeaseHandle).release();
  });

  it("gives the UI-test slot back when the heavy wait is refused", async () => {
    const blocker = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), plain)!;
    const refused = await take(ui, { maxWaitMs: 10_000 }, { policy: { heavyCeiling: 1, heavyWarning: 1 } });
    expect(refused).toMatchObject({ refused: "max-wait" });
    expect(names("ui-tests")).toEqual([]);
    expect(names("ui-tests-waiting")).toEqual([]);
    blocker.release();
  });

  it("spends one maxWaitMs across both waits", async () => {
    // Another process's UI-test run expires 6 s in; the heavy slot is never free.
    plantHolder(lease, "other-ui", { pid: process.pid, expiresAt: lease.clock.ms + 6_000 }, { sub: "ui-tests" });
    const blocker = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), plain)!;
    const refused = await take(ui, { maxWaitMs: 10_000 }, { policy: { heavyCeiling: 1, heavyWarning: 1 } });
    expect(refused).toMatchObject({ refused: "max-wait" });
    expect(lease.clock.sleeps.length).toBeGreaterThan(2);
    expect(lease.clock.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
    blocker.release();
  });

  describe("never runs unchecked", () => {
    let restore = () => {};
    afterEach(() => restore());

    it("keeps waiting on an I/O error instead of failing open, until maxWaitMs refuses", async () => {
      restore = failFsCall("openSync", (p) => p.endsWith(".mutex"), "EACCES");
      const r = await take(ui, { maxWaitMs: 30_000 });
      expect(r).toMatchObject({ refused: "max-wait" });
      expect(lease.events.some((e) => e.type === "fail-open")).toBe(false);
      expect(lease.warnings).toEqual([]);
      expect(names("holders")).toEqual([]);
    });

    it("still fails open for an ordinary heavy command on the same error", async () => {
      restore = failFsCall("openSync", (p) => p.endsWith(".mutex"), "EACCES");
      const r = await take(plain, { maxWaitMs: 30_000 });
      expect(r).toMatchObject({ leased: false });
      expect(lease.events.filter((e) => e.type === "fail-open")).toHaveLength(1);
    });
  });

  describe("a detached holder (hook mode)", () => {
    const detached = (): NonNullable<HolderMeta["detached"]> => ({ id: "hook-t1", sessionPid: process.pid, get expiresAt() { return lease.clock.ms + 120_000; } });

    it("is released from both classes by id, one event each", async () => {
      const h = (await take({ ...ui, detached: detached() })) as LeaseHandle;
      expect(names("ui-tests")).toEqual(["hook-t1.json"]);
      expect(names("holders")).toEqual(["hook-t1.json"]);
      expect(h.id).toBe("hook-t1");
      lease.events.length = 0;
      expect(releaseHolder(opts(), "hook-t1")).toBe(true);
      expect(names("ui-tests")).toEqual([]);
      expect(names("holders")).toEqual([]);
      expect(lease.events.map((e) => [e.type, e.class]).sort()).toEqual([["release", "heavy"], ["release", "ui-tests"]]);
      expect(releaseHolder(opts(), "hook-t1")).toBe(false);
    });

    it("counts the UI-test holder's expiry from the heavy admission, so a long heavy wait does not eat the call's time", async () => {
      const blocker = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), plain)!;
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length === 3) blocker.release();
      };
      await take({ ...ui, detached: detached() }, { maxWaitMs: 450_000 }, { policy: { heavyCeiling: 1, heavyWarning: 1 } });
      expect(lease.clock.sleeps.length).toBeGreaterThanOrEqual(3);
      expect(holder("ui-tests", "hook-t1").expiresAt).toBe(lease.clock.ms + 120_000);
      expect(holder("holders", "hook-t1").expiresAt).toBe(lease.clock.ms + 120_000);
    });

    it("lets a nested acquire inherit both slots without a second holder in either class", async () => {
      await take({ ...ui, detached: detached() });
      const nested = (await take(ui, { maxWaitMs: 0 }, { inheritedHolderId: "hook-t1" })) as LeaseHandle;
      expect(nested.leased).toBe(true);
      expect(names("ui-tests")).toEqual(["hook-t1.json"]);
      expect(names("holders")).toEqual(["hook-t1.json"]);
      nested.release();
      expect(names("ui-tests")).toEqual(["hook-t1.json"]);
    });
  });
});
