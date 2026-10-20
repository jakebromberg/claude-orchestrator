import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSessionLease, leaseStatus, tryAcquireLease, type HolderMeta, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { DEFAULT_STEP_TABLE, headroomStep, heavyBudget, RAMP_MS, sessionHeadroomCapacity, type HeadroomState } from "../src/headroom.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const GB = 2 ** 30;
/** 16 GB with the default 25% reserve: 12 GB usable, a 4 GB reserve, 3 GB for an unmatched command. */
const MEMSIZE = 16 * GB;
const meta: HolderMeta = { command: "npm test", cwd: "/work" };
const reading = (step: number, freePct?: number): HeadroomReading => ({
  level: step === 0 ? "critical" : "normal",
  step,
  signals: { level: step === 0 ? "critical" : "normal", memsizeBytes: MEMSIZE, ...(freePct !== undefined && { freePct }) },
});

describe("heavyBudget from free memory", () => {
  const free = (freeBytes: number, settled = 0) => ({ freeBytes, reserve: 4 * GB, settled });

  it.each<[name: string, step: number, freeBytes: number, settled: number, expected: number]>([
    ["is free memory less the reserve", 4, 10 * GB, 0, 6 * GB],
    ["adds back the settled holders' weight", 4, 6 * GB, 3 * GB, 5 * GB],
    ["never exceeds the usable bytes", 4, 16 * GB, 6 * GB, 12 * GB],
    ["is 0 once free memory is inside the reserve", 4, 3 * GB, 0, 0],
    ["is 0 at step 0 however much is free", 0, 16 * GB, 0, 0],
    ["does not scale with the step above 0", 1, 10 * GB, 0, 6 * GB],
  ])("%s", (_name, step, freeBytes, settled, expected) => {
    expect(heavyBudget(step, 12 * GB, free(freeBytes, settled))).toBe(expected);
  });

  it("falls back to the step's share of the usable bytes without a free reading", () => {
    expect(heavyBudget(3, 12 * GB)).toBe(9 * GB);
  });
});

describe("heavy admission against free memory", () => {
  let tmp: string;
  let dir: string;
  let lease: ScriptedLease;
  const at = (r: HeadroomReading, over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts({ headroom: scriptedHeadroomSampler(r), ...over });
  const take = (o: LeaseOptions, weight?: number): LeaseHandle | null => tryAcquireLease(o, { ...meta, weight });
  const count = (o: LeaseOptions, weight?: number): number => {
    let n = 0;
    while (take(o, weight)) n++;
    return n;
  };
  const plant = (id: string, startedAt: number, weight: number): void => {
    mkdirSync(join(dir, "holders"), { recursive: true, mode: 0o700 });
    const file = join(dir, "holders", `4242-${id}.json`);
    writeFileSync(file, JSON.stringify({ id: `4242-${id}`, pid: 4242, command: "x", cwd: "/", startedAt, level: "normal", weight }));
    utimesSync(file, (lease.clock.ms + 0.5) / 1000, (lease.clock.ms + 0.5) / 1000);
  };

  /** Refreshes every holder's heartbeat at the fake clock, as a live holder's own timer would. */
  const beat = (): void => readdirSync(join(dir, "holders")).forEach((f) => utimesSync(join(dir, "holders", f), lease.clock.ms / 1000, lease.clock.ms / 1000));

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-free-budget-"));
    dir = join(tmp, "lease");
    lease = scriptedLease(dir, { policy: { heavyCeiling: 4, heavyWarning: 1 }, alive: [process.pid, 4242] });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it.each<[name: string, step: number, freePct: number | undefined, expected: number]>([
    ["an idle machine admits the full ceiling", 4, 100, 4],
    ["8 GB used outside the lease admits one 3 GB command at the normal level", 4, 50, 1],
    ["10 GB free admits two", 4, 62.5, 2],
    ["free memory inside the reserve admits one command alone", 4, 20, 1],
    ["no free reading falls back to the step's budget", 3, undefined, 3],
    ["step 0 admits nothing", 0, 100, 0],
  ])("%s", (_name, step, freePct, expected) => {
    expect(count(at(reading(step, freePct)))).toBe(expected);
  });

  it("falls back to the level step when the sampler gives no memory signals", () => {
    const o = at({ level: "normal", step: 3, signals: { level: "normal" } });
    expect(count(o)).toBe(3);
  });

  it("charges young holders in full on one idle reading, so a burst admits only what fits", () => {
    const o = at(reading(4, 62.5));
    expect(take(o, 3 * GB)).not.toBeNull();
    expect(take(o, 3 * GB)).not.toBeNull();
    expect(take(o, 3 * GB)).toBeNull();
    expect(leaseStatus(o).weights).toEqual({ used: 6 * GB, budget: 6 * GB });
  });

  it("adds a holder's weight back once it is older than the ramp window", () => {
    const o = at(reading(4, 62.5));
    take(o, 3 * GB);
    lease.clock.ms += RAMP_MS - 1;
    beat();
    expect(leaseStatus(o).weights).toEqual({ used: 3 * GB, budget: 6 * GB });
    lease.clock.ms += 1;
    beat();
    expect(leaseStatus(o).weights).toEqual({ used: 3 * GB, budget: 9 * GB });
    const beating = (): LeaseHandle | null => {
      const h = take(o, 3 * GB);
      beat();
      return h;
    };
    expect(beating()).not.toBeNull();
    expect(beating()).not.toBeNull();
    expect(beating()).toBeNull();
  });

  it("adds back only the older holder's weight when one is older and one younger", () => {
    const o = at(reading(4, 62.5));
    plant("old", lease.clock.ms - RAMP_MS - 1, 2 * GB);
    plant("young", lease.clock.ms - 1000, 3 * GB);
    expect(leaseStatus(o).weights).toEqual({ used: 5 * GB, budget: 8 * GB });
  });

  it("charges a holder dated in the future as young", () => {
    const o = at(reading(4, 62.5));
    plant("future", lease.clock.ms + 10 * RAMP_MS, 3 * GB);
    expect(leaseStatus(o).weights).toEqual({ used: 3 * GB, budget: 6 * GB });
  });

  it("reports one budget in status, the admission and the acquire event", () => {
    const o = at(reading(4, 62.5));
    plant("old", lease.clock.ms - RAMP_MS - 1, 2 * GB);
    const h = take(o, GB)!;
    expect(leaseStatus(o).weights).toEqual({ used: 3 * GB, budget: 8 * GB });
    expect(h.admission.weights).toEqual({ used: 3 * GB, budget: 8 * GB, weight: GB });
    expect(lease.events.filter((e) => e.type === "acquire").at(-1)).toMatchObject({ weights: { budget: 8 * GB } });
  });

  it("keeps an older waiting ticket ahead of a younger request when free memory inside the reserve leaves a budget of 0 above step 0", () => {
    const o = at(reading(4, 20));
    mkdirSync(join(dir, "waiting"), { recursive: true, mode: 0o700 });
    const ticket = join(dir, "waiting", "older.json");
    writeFileSync(ticket, JSON.stringify({ seq: 1, id: "older", pid: 4242, label: "other", gated: false, capacity: 4, ceiling: 4, ready: true }));
    utimesSync(ticket, (lease.clock.ms + 0.5) / 1000, (lease.clock.ms + 0.5) / 1000);
    expect(leaseStatus(o).weights?.budget).toBe(0);
    expect(take(o)).toBeNull();
  });

  it("keeps a session row at its own capacity whatever the free memory", async () => {
    const o = at(reading(4, 20), { sessionSlots: 3 });
    let n = 0;
    while ("leased" in (await acquireSessionLease(o, meta, { maxWaitMs: 0 }))) n++;
    expect(n).toBe(3);
  });
});

describe("the step's rise", () => {
  const climb = (): number[] => {
    let state: HeadroomState = { step: 1, risingSince: null };
    const steps: number[] = [];
    for (let t = 0; t <= 3 * RAMP_MS; t += RAMP_MS / 2) {
      state = headroomStep({ level: "normal", freePct: 60 }, state, 1_000_000 + t, DEFAULT_STEP_TABLE);
      steps.push(state.step);
    }
    return steps;
  };

  it("holds each rise for at least the ramp window", () => {
    expect(DEFAULT_STEP_TABLE.riseHoldMs).toBeGreaterThanOrEqual(RAMP_MS);
  });

  it("returns session slots one band per ramp window after a dip, sharing the slower rise", () => {
    const steps = climb();
    expect(steps).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(steps.map((s) => sessionHeadroomCapacity(s, 6))).toEqual([1, 1, 2, 2, 4, 4, 6]);
  });
});
