import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, acquireSessionLease, defaultLeaseOptions, leaseStatus, tryAcquireLease, type HolderMeta, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { headroomCapacity, sessionHeadroomCapacity } from "../src/headroom.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const GB = 2 ** 30;
/** 16 GB of memory with the default 25% reserve leaves 12 GB usable; at a ceiling of 4 an unmatched command weighs 3 GB. */
const MEMSIZE = 16 * GB;
const meta: HolderMeta = { command: "npm test", cwd: "/work" };
const reading = (step: number, memsizeBytes: number | null = MEMSIZE, level: HeadroomReading["level"] = step === 0 ? "critical" : "normal"): HeadroomReading => ({
  level,
  step,
  signals: { level, ...(memsizeBytes !== null && { memsizeBytes }) },
});

describe("heavy admission by summed memory weight", () => {
  let tmp: string;
  let dir: string;
  let lease: ScriptedLease;

  const at = (step: number, over: Partial<LeaseOptions> = {}, memsize: number | null = MEMSIZE): LeaseOptions =>
    lease.opts({ headroom: scriptedHeadroomSampler(reading(step, memsize)), ...over });
  const names = (sub: string): string[] => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).sort() : []);
  const plant = (sub: string, id: string, body: Record<string, unknown>): void => {
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, sub, `${id}.json`), JSON.stringify(body));
    utimesSync(join(dir, sub, `${id}.json`), (lease.clock.ms + 0.5) / 1000, (lease.clock.ms + 0.5) / 1000);
  };
  /** Live heavy holders written by another process; `undefined` is a holder with no weight, and anything else is recorded as given. */
  const plantHolders = (...weights: unknown[]): void =>
    weights.forEach((weight, i) => plant("holders", `4242-live${i}`, { id: `4242-live${i}`, pid: 4242, command: "x", cwd: "/", startedAt: lease.clock.ms, level: "normal", ...(weight !== undefined && { weight }) }));
  const plantTicket = (id: string, seq: number, extra: Record<string, unknown> = {}): void => {
    lease.alive.add(5000 + seq);
    plant("waiting", id, { seq, id, pid: 5000 + seq, label: "other", gated: false, capacity: 4, ceiling: 4, ...extra });
  };
  const take = (o: LeaseOptions, weight?: number): LeaseHandle | null => tryAcquireLease(o, { ...meta, weight });
  const admitted = (o: LeaseOptions, weight?: number): boolean => {
    const h = take(o, weight);
    h?.release();
    return h !== null;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-weights-"));
    dir = join(tmp, "lease");
    lease = scriptedLease(dir, { policy: { heavyCeiling: 4, heavyWarning: 1 }, alive: [process.pid, 4242] });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  describe("with every holder at the unmatched weight", () => {
    it.each([0, 1, 2, 3, 4])("admits as many as the count rule at step %i, whatever the machine's memory or reserve", (step) => {
      const count = (over: Partial<LeaseOptions>, memsize: number | null = MEMSIZE): number => {
        const o = at(step, over, memsize);
        let n = 0;
        while (take(o)) n++;
        rmSync(join(dir, "holders"), { recursive: true, force: true });
        return n;
      };
      const expected = headroomCapacity(step, 4);
      expect(count({}, null)).toBe(expected);
      expect(count({})).toBe(expected);
      expect(count({ reservePct: 60 })).toBe(expected);
      expect(count({}, 3 * GB)).toBe(expected);
    });

    it.each([1, 6])("keeps the count rule at step 4 with a ceiling of %i slots", (ceiling) => {
      const o = at(4, { policy: { heavyCeiling: ceiling, heavyWarning: 1 } });
      let n = 0;
      while (take(o)) n++;
      expect(n).toBe(ceiling);
    });

    // The budget is proportional (`usable × step / 4`) and an unmatched weight is `usable / ceiling`, so a step admits floor(ceiling × step / 4) holders, at least one above step 0.
    // That equals the count rule `min(ceiling, step)` at the default ceiling of 4 and differs at other `CO_LEASE_SLOTS` values (owner decision on #218).
    it.each([
      { ceiling: 8, step: 0, weights: 0, count: 0 },
      { ceiling: 8, step: 1, weights: 2, count: 1 },
      { ceiling: 8, step: 2, weights: 4, count: 2 },
      { ceiling: 8, step: 3, weights: 6, count: 3 },
      { ceiling: 8, step: 4, weights: 8, count: 8 },
      { ceiling: 2, step: 1, weights: 1, count: 1 },
      { ceiling: 2, step: 2, weights: 1, count: 2 },
      { ceiling: 2, step: 3, weights: 1, count: 2 },
      { ceiling: 3, step: 2, weights: 1, count: 2 },
    ])("admits $weights, not the count rule's $count, at step $step with a ceiling of $ceiling", ({ ceiling, step, weights, count }) => {
      const o = at(step, { policy: { heavyCeiling: ceiling, heavyWarning: 1 } });
      let n = 0;
      while (take(o)) n++;
      expect(n).toBe(weights);
      expect(headroomCapacity(step, ceiling)).toBe(count);
      // With the machine's memory unknown the count rule applies at any ceiling.
      rmSync(join(dir, "holders"), { recursive: true, force: true });
      const unknown = at(step, { policy: { heavyCeiling: ceiling, heavyWarning: 1 } }, null);
      let m = 0;
      while (take(unknown)) m++;
      expect(m).toBe(count);
    });

    it("leaves the session row alone at every step, with the machine's memory known", async () => {
      for (const step of [0, 1, 2, 3, 4]) {
        const o = at(step, { sessionSlots: 6 });
        let n = 0;
        for (;;) {
          const r = await acquireSessionLease(o, meta, { maxWaitMs: 0 });
          if (!("leased" in r)) break;
          n++;
        }
        expect(n).toBe(sessionHeadroomCapacity(step, 6));
        rmSync(join(dir, "sessions"), { recursive: true, force: true });
      }
    });
  });

  describe("summed admission", () => {
    // Step 4 has a 12 GB budget, step 2 has 6 GB.
    it.each<[name: string, step: number, live: unknown[], weight: number | undefined, expected: boolean]>([
      ["fits exactly", 4, [5 * GB, 5 * GB], 2 * GB, true],
      ["is a byte over", 4, [5 * GB, 5 * GB], 2 * GB + 2, false],
      ["fits beside many light holders", 4, [GB, GB, GB, GB, GB], 6 * GB, true],
      ["is refused by one heavy holder though few are live", 4, [11 * GB], 2 * GB, false],
      ["counts an unweighted holder as 3 GB", 4, [undefined, undefined, 5 * GB], 1 * GB, true],
      ["counts an unweighted holder as 3 GB, and refuses past it", 4, [undefined, undefined, 5 * GB], 1 * GB + 2, false],
      ["takes the unmatched weight itself when it passes none", 4, [3 * GB, 3 * GB, 3 * GB], undefined, true],
      ["is refused at the unmatched weight past the budget", 4, [3 * GB, 3 * GB, 3 * GB, GB], undefined, false],
      ["reads a holder weight of zero as unmatched", 4, [0, 0, 0], 3 * GB, true],
      ["reads a holder weight of zero as unmatched, and refuses past it", 4, [0, 0, 0, 0], 3 * GB, false],
      ["reads a negative or text holder weight as unmatched", 4, [-5, "heavy", null, 3 * GB], 3 * GB, false],
      ["fits the lower step's budget", 2, [3 * GB], 3 * GB, true],
      ["is refused past the lower step's budget", 2, [3 * GB], 3 * GB + 2, false],
      ["is refused at step 0 however light", 0, [], 1, false],
    ])("a command that %s", (_name, step, live, weight, expected) => {
      plantHolders(...live);
      expect(admitted(at(step), weight)).toBe(expected);
    });

    it.each<[name: string, step: number, live: number[], weight: number, expected: boolean]>([
      ["alone, heavier than the budget", 4, [], 20 * GB, true],
      ["alone, heavier than a low step's budget", 1, [], 5 * GB, true],
      ["behind one light holder", 4, [GB], 20 * GB, false],
      ["alone at step 0", 0, [], 20 * GB, false],
    ])("an oversize command %s is admitted: %s", (_name, step, live, weight, expected) => {
      plantHolders(...live);
      expect(admitted(at(step), weight)).toBe(expected);
    });

    it("refuses the next command while an oversize holder runs", () => {
      const o = at(4);
      const big = take(o, 20 * GB)!;
      expect(take(o, GB)).toBeNull();
      big.release();
      expect(admitted(o, GB)).toBe(true);
    });

    it("records a weight it was given on its holder, and none otherwise", () => {
      const o = at(4);
      const heavy = take(o, 5 * GB)!;
      const plain = take(o)!;
      const recorded = (h: LeaseHandle): unknown => JSON.parse(readFileSync(join(dir, "holders", `${h.id}.json`), "utf8")).weight;
      expect([recorded(heavy), recorded(plain)]).toEqual([5 * GB, undefined]);
      expect(leaseStatus(o).live.map((h) => h.weight).sort()).toEqual([5 * GB, undefined]);
    });

    it("falls back to the count rule when the machine's memory is unknown, ignoring weights", () => {
      plantHolders(11 * GB);
      expect(admitted(at(4, {}, null), 20 * GB)).toBe(true);
      plantHolders(11 * GB, 11 * GB, 11 * GB, 11 * GB);
      expect(admitted(at(4, {}, null), GB)).toBe(false);
    });
  });

  describe("FIFO with mixed weights", () => {
    // Step 4: a 12 GB budget with 6 GB live leaves 6 GB.
    it.each<[name: string, ahead: Record<string, unknown>[], weight: number, expected: boolean]>([
      ["no waiter ahead", [], 6 * GB, true],
      ["a heavy waiter ahead blocks a light one behind it", [{ weight: 8 * GB }], 1 * GB, false],
      ["a light waiter ahead leaves room for one that fits beside it", [{ weight: 2 * GB }], 4 * GB, true],
      ["a light waiter ahead and a command that does not fit beside it", [{ weight: 2 * GB }], 4 * GB + 2, false],
      ["two waiters ahead take their weights from the room", [{ weight: 2 * GB }, { weight: 3 * GB }], GB, true],
      ["two waiters ahead take their weights from the room, and refuse past it", [{ weight: 2 * GB }, { weight: 3 * GB }], GB + 2, false],
      ["a waiter ahead with no weight counts as 3 GB", [{}], 3 * GB, true],
      ["a waiter ahead with no weight counts as 3 GB, and refuses past it", [{}], 3 * GB + 2, false],
      ["a waiter ahead with an invalid weight counts as 3 GB", [{ weight: "big" }], 3 * GB + 2, false],
      ["a waiter whose gates have not passed does not count", [{ weight: 8 * GB, ready: false }], 6 * GB, true],
    ])("with %s", async (_name, ahead, weight, expected) => {
      plantHolders(6 * GB);
      ahead.forEach((t, i) => plantTicket(`ahead${i}`, i + 1, t));
      const r = await acquireLease(at(4), { ...meta, weight }, { maxWaitMs: 0 });
      expect("leased" in r).toBe(expected);
      (r as LeaseHandle).release?.();
    });

    it("lets a non-waiting acquire in only when no ticket counts as ahead", () => {
      plantTicket("ahead", 1, { weight: GB });
      expect(admitted(at(4), GB)).toBe(false);
    });

    it("keeps an oversize waiter waiting while anything is live, and leaves no ticket behind", async () => {
      plantHolders(GB);
      expect(await acquireLease(at(4), { ...meta, weight: 20 * GB }, { maxWaitMs: 0 })).toMatchObject({ refused: "max-wait" });
      expect(names("waiting")).toEqual([]);
    });

    it("records its weight on its ticket: the one it passed, else the unmatched weight", async () => {
      plantHolders(11 * GB);
      const seen: Record<string, unknown>[] = [];
      for (const weight of [5 * GB, undefined]) {
        await acquireLease(at(4), { ...meta, weight }, {
          maxWaitMs: 1,
          onWait: () => seen.push(JSON.parse(readFileSync(join(dir, "waiting", names("waiting")[0]!), "utf8"))),
        });
      }
      expect(seen.map((t) => t.weight)).toEqual([5 * GB, 3 * GB]);
      expect(seen[0]).toMatchObject({ capacity: 4, ceiling: 4 });
    });

    it("writes no weight on its ticket when the machine's memory is unknown", async () => {
      plantHolders(undefined, undefined, undefined, undefined);
      let ticket: Record<string, unknown> | undefined;
      await acquireLease(at(4, {}, null), { ...meta, weight: GB }, {
        maxWaitMs: 1,
        onWait: () => (ticket = JSON.parse(readFileSync(join(dir, "waiting", names("waiting")[0]!), "utf8"))),
      });
      expect(ticket).not.toHaveProperty("weight");
    });
  });

  describe("a ticket at the current step", () => {
    const overridden = (): LeaseOptions => lease.opts({ headroom: scriptedHeadroomSampler(reading(1, MEMSIZE, "warning"), { overridden: true }) });

    it.each<[name: string, ticket: Record<string, unknown>, expected: boolean]>([
      ["an older ticket counts at the machine's step 0 only with the override", { weight: 8 * GB, override: true }, false],
      ["an older ticket without the override is not ahead when the machine is at step 0", { weight: 8 * GB }, true],
    ])("with %s", (_name, ticket, expected) => {
      plantTicket("older", 1, ticket);
      expect(admitted(overridden(), GB)).toBe(expected);
    });

    // Three live holders exceed the ticket's count capacity at step 2 (2), so only the weight rule counts it as ahead; the count rule would let every light newcomer pass it.
    it("counts a ticket heavier than the current budget as ahead, so lighter newcomers do not starve it", () => {
      plantHolders(GB, GB, GB);
      plantTicket("older", 1, { weight: 20 * GB });
      expect(admitted(at(2), GB)).toBe(false);
    });

    it("admits an oversize waiter, alone, once nothing is live at a step above 0", () => {
      expect(admitted(at(2), 20 * GB)).toBe(true);
    });
  });

  describe("defaultLeaseOptions", () => {
    it.each<[env: Record<string, string>, pct: number | undefined]>([
      [{}, 25],
      [{ CO_LEASE_RESERVE_PCT: "10" }, 10],
      [{ CO_LEASE_RESERVE_PCT: "lots" }, 25],
    ])("reads the reserve from %j as %s", (env, pct) => {
      const warnings: string[] = [];
      const o = defaultLeaseOptions({ CO_LEASE_DIR: dir, ...env }, { warn: (m) => void warnings.push(m) });
      expect(o.reservePct).toBe(pct);
      expect(warnings.length).toBe(env.CO_LEASE_RESERVE_PCT === "lots" ? 1 : 0);
    });
  });
});
