import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, leaseStatus, releaseHolder, tryAcquireLease, type HolderMeta, type LeaseHandle, type LeaseOptions, type LeaseRefusal } from "../src/lease.js";
import { failFsCall, plantHolder, plantTicket, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

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
    expect(refused).not.toHaveProperty("class");
    expect(names("ui-tests")).toEqual([]);
    expect(names("ui-tests-waiting")).toEqual([]);
    blocker.release();
  });

  it("labels a refusal in the UI-test phase with its class, so the caller prints that class's status", async () => {
    const first = (await take(ui)) as LeaseHandle;
    expect(await take(ui, { maxWaitMs: 0 })).toMatchObject({ refused: "max-wait", class: "ui-tests" });
    first.release();
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

  // Issue #324 review: `childEnv()` exports one holder id, so the two holders of a run that has no detached id must share it, or a nested
  // acquire that inherits it borrows the heavy slot and then waits forever for the UI-test slot its own parent holds.
  describe("a run's two holders share one id", () => {
    it("so a nested acquire that inherits the exported id borrows both slots at once", async () => {
      const parent = (await take(ui)) as LeaseHandle;
      expect(names("ui-tests")).toEqual(names("holders"));
      const inherited = parent.childEnv().CO_LEASE_HOLDER!;
      expect(names("ui-tests")).toEqual([`${inherited}.json`]);
      const nested = await take(ui, { maxWaitMs: 0 }, { inheritedHolderId: inherited });
      expect(isHandle(nested) && nested.leased).toBe(true);
      expect(names("ui-tests")).toEqual([`${inherited}.json`]);
      expect(names("holders")).toEqual([`${inherited}.json`]);
      (nested as LeaseHandle).release();
      expect(names("ui-tests")).toEqual([`${inherited}.json`]);
      parent.release();
      expect(names("ui-tests")).toEqual([]);
    });
  });

  describe("a persistent I/O error", () => {
    let restore = () => {};
    afterEach(() => restore());

    it("is refused after a bounded number of consecutive polls even when the caller sets no maxWaitMs", async () => {
      restore = failFsCall("openSync", (p) => p.endsWith(".mutex"), "EACCES");
      const r = await take(ui, {});
      expect(r).toMatchObject({ refused: "io-error", class: "ui-tests", code: "EACCES" });
      expect(lease.clock.sleeps).toHaveLength(19);
      expect(lease.events.some((e) => e.type === "fail-open")).toBe(false);
      expect(lease.events.filter((e) => e.type === "timeout")).toEqual([expect.objectContaining({ refused: "io-error", class: "ui-tests" })]);
      expect(names("ui-tests")).toEqual([]);
    });

    it("is not refused when it clears: one good poll resets the count", async () => {
      restore = failFsCall("openSync", (p) => p.endsWith(".mutex"), "EACCES");
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length === 15) restore();
      };
      const r = await take(ui, {});
      expect(isHandle(r) && r.leased).toBe(true);
      (r as LeaseHandle).release();
    });
  });

  it("gives the UI-test slot back when the heavy acquire throws", async () => {
    const blocker = tryAcquireLease(opts({ policy: { heavyCeiling: 1, heavyWarning: 1 } }), plain)!;
    const sleep = async (): Promise<void> => {
      throw new Error("sleep failed");
    };
    await expect(take(ui, { maxWaitMs: 60_000 }, { policy: { heavyCeiling: 1, heavyWarning: 1 }, sleep })).rejects.toThrow("sleep failed");
    expect(names("ui-tests")).toEqual([]);
    expect(names("ui-tests-waiting")).toEqual([]);
    blocker.release();
  });

  // Issue #324 review: the UI-test holder of a hook call is created before the heavy wait, which can outlast the call's own time, so it is
  // renewed on every heavy poll; a holder that is gone fails the acquire instead of letting a second UI run proceed beside it.
  describe("a hook's UI-test holder during a long heavy wait", () => {
    const policy = { heavyCeiling: 1, heavyWarning: 1 };
    const detachedFor = (id: string): NonNullable<HolderMeta["detached"]> => ({ id, sessionPid: process.pid, get expiresAt() { return lease.clock.ms + 120_000; } });

    it("stays live past its original expiry, so a competing UI-test waiter never takes the slot", async () => {
      // A detached blocker, so the minutes of scripted time do not reap it for want of a heartbeat.
      const blocker = tryAcquireLease(opts({ policy }), { ...plain, detached: { id: "hook-blocker", sessionPid: process.pid, expiresAt: lease.clock.ms + 700_000 } })!;
      const start = lease.clock.ms;
      const competitors: Promise<LeaseHandle | LeaseRefusal>[] = [];
      lease.clock.onSleep = () => {
        const waited = lease.clock.ms - start;
        if (waited >= 200_000 && competitors.length < 3) competitors.push(acquireLease(opts({ policy }), { ...ui, detached: detachedFor(`hook-c${competitors.length}`) }, { maxWaitMs: 0 }));
        if (waited >= 400_000) blocker.release();
      };
      const r = await take({ ...ui, detached: detachedFor("hook-t1") }, { maxWaitMs: 450_000 }, { policy });
      expect(isHandle(r) && r.leased).toBe(true);
      expect(lease.clock.ms - start).toBeGreaterThan(200_000);
      expect(competitors).toHaveLength(3);
      for (const c of await Promise.all(competitors)) if (isHandle(c)) c.release();
      expect(lease.events.filter((e) => e.type === "acquire" && e.class === "ui-tests").map((e) => (e as { id: string }).id)).toEqual(["hook-t1"]);
      expect(lease.events.some((e) => e.type === "reap" && e.id === "hook-t1")).toBe(false);
      expect(holder("ui-tests", "hook-t1").expiresAt).toBe(lease.clock.ms + 120_000);
      (r as LeaseHandle).release();
    });

    it("refuses with slot-lost when the holder disappears during the wait, holding no slot of either class", async () => {
      const blocker = tryAcquireLease(opts({ policy }), plain)!;
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length === 2) rmSync(join(lease.dir, "ui-tests", "hook-t1.json"));
      };
      const r = await take({ ...ui, detached: detachedFor("hook-t1") }, { maxWaitMs: 450_000 }, { policy });
      expect(r).toMatchObject({ refused: "slot-lost", class: "ui-tests" });
      expect(names("ui-tests")).toEqual([]);
      expect(names("holders")).toHaveLength(1); // the unrelated blocker only
      expect(names("holders")).not.toContain("hook-t1.json");
      expect(names("waiting")).toEqual([]);
      blocker.release();
    });

    it("refuses with slot-lost when the holder is gone at the heavy admission, and gives the heavy slot back", async () => {
      const blocker = tryAcquireLease(opts({ policy }), plain)!;
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length === 1) {
          rmSync(join(lease.dir, "ui-tests", "hook-t1.json"));
          blocker.release();
        }
      };
      const r = await take({ ...ui, detached: detachedFor("hook-t1") }, { maxWaitMs: 450_000 }, { policy });
      expect(r).toMatchObject({ refused: "slot-lost", class: "ui-tests" });
      expect(names("holders")).toEqual([]);
      expect(names("ui-tests")).toEqual([]);
    });
  });

  // Issue #324 review: a heavy-queue, `cli-lease run` or post-check UI holder has no `expiresAt`, only a heartbeat; the heavy wait must keep it
  // fresh, and a holder that a stall let another waiter reap must refuse the run rather than be admitted beside the new holder.
  describe("a non-detached UI-test holder during a long heavy wait", () => {
    const policy = { heavyCeiling: 1, heavyWarning: 1 };
    const blockerFor = () => tryAcquireLease(opts({ policy }), { ...plain, detached: { id: "hook-blocker", sessionPid: process.pid, expiresAt: lease.clock.ms + 700_000 } })!;
    const uiAcquires = (): string[] => lease.events.filter((e) => e.type === "acquire" && e.class === "ui-tests").map((e) => (e as { id: string }).id);

    it("keeps its heartbeat fresh past 90 s, so a competing UI-test waiter never reaps it", async () => {
      const blocker = blockerFor();
      const start = lease.clock.ms;
      const competitors: Promise<LeaseHandle | LeaseRefusal>[] = [];
      lease.clock.onSleep = () => {
        const waited = lease.clock.ms - start;
        if (waited >= 200_000 && competitors.length < 3) competitors.push(acquireLease(opts({ policy }), ui, { maxWaitMs: 0 }));
        if (waited >= 400_000) blocker.release();
      };
      const r = await take(ui, { maxWaitMs: 450_000 }, { policy });
      expect(isHandle(r) && r.leased).toBe(true);
      expect(competitors).toHaveLength(3);
      for (const c of await Promise.all(competitors)) if (isHandle(c)) c.release();
      expect(uiAcquires()).toEqual([(r as LeaseHandle).id]);
      expect(lease.events.some((e) => e.type === "reap")).toBe(false);
      (r as LeaseHandle).release();
    });

    it("refuses with slot-lost when a stall let another waiter reap it, and the new holder keeps the slot", async () => {
      const blocker = blockerFor();
      let taker: Promise<LeaseHandle | LeaseRefusal> | undefined;
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length !== 2) return;
        lease.clock.ms += 200_000; // the machine stalls: no heartbeat, no poll
        taker = acquireLease(opts({ policy }), ui, { maxWaitMs: 0 });
      };
      const r = await take(ui, { maxWaitMs: 450_000 }, { policy });
      expect(r).toMatchObject({ refused: "slot-lost", class: "ui-tests" });
      await taker;
      expect(lease.events.filter((e) => e.type === "reap" && e.class === "ui-tests")).toEqual([expect.objectContaining({ reason: "stale-heartbeat" })]);
      expect(uiAcquires()).toHaveLength(2);
      expect(names("holders")).toHaveLength(1); // the blocker only
      blocker.release();
    });

    it("refuses with slot-lost when its file is gone at the heavy admission, and gives the heavy slot back", async () => {
      const blocker = blockerFor();
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length !== 1) return;
        for (const f of names("ui-tests")) rmSync(join(lease.dir, "ui-tests", f));
        blocker.release();
      };
      const r = await take(ui, { maxWaitMs: 450_000 }, { policy });
      expect(r).toMatchObject({ refused: "slot-lost", class: "ui-tests" });
      expect(names("holders")).toEqual([]);
      expect(names("ui-tests")).toEqual([]);
    });

    it("does not recreate a reaped holder's file when it finds it gone", async () => {
      const blocker = blockerFor();
      lease.clock.onSleep = () => {
        if (lease.clock.sleeps.length === 1) for (const f of names("ui-tests")) rmSync(join(lease.dir, "ui-tests", f));
      };
      await take({ ...ui, detached: { id: "hook-t9", sessionPid: process.pid, expiresAt: lease.clock.ms + 120_000 } }, { maxWaitMs: 450_000 }, { policy });
      expect(names("ui-tests")).toEqual([]);
      blocker.release();
    });
  });

  // `lease status` shows who holds and who waits for the UI-test slot, as it does for the heavy class.
  describe("lease status", () => {
    it("lists the UI-test holders and waiters, and nothing when there are none", async () => {
      expect(leaseStatus(opts())).not.toHaveProperty("uiTests");
      const h = (await take(ui)) as LeaseHandle;
      plantTicket(lease, "waiter-1", 1, { label: "xcodebuild test -scheme B" }, { sub: "ui-tests-waiting" });
      const status = leaseStatus(opts());
      expect(status.uiTests).toMatchObject({ capacity: 1, live: [expect.objectContaining({ id: h.id, command: ui.command })], waiting: [expect.objectContaining({ seq: 1, label: "xcodebuild test -scheme B" })] });
      h.release();
      expect(leaseStatus(opts()).uiTests).toMatchObject({ live: [], waiting: [expect.objectContaining({ seq: 1 })] });
    });
  });

  // A nested acquire that inherits a heavy slot with no UI-test slot behind it would wait for the UI-test slot while holding the heavy one,
  // which can deadlock against the run that holds the UI-test slot and waits for heavy capacity, so it is refused at once.
  it("refuses at once a nested UI-test acquire whose inherited holder is live in the heavy class only", async () => {
    plantHolder(lease, "parent-1", { pid: process.pid });
    const r = await take(ui, { maxWaitMs: 600_000 }, { inheritedHolderId: "parent-1" });
    expect(r).toMatchObject({ refused: "nested-ui-test", waitedMs: 0 });
    expect(lease.clock.sleeps).toEqual([]);
    expect(names("ui-tests")).toEqual([]);
    expect(names("ui-tests-waiting")).toEqual([]);
  });

  it("does not refuse a nested acquire whose inherited holder is gone: it acquires normally", async () => {
    const r = await take(ui, { maxWaitMs: 0 }, { inheritedHolderId: "no-such-holder" });
    expect(isHandle(r) && r.leased).toBe(true);
    (r as LeaseHandle).release();
  });
});
