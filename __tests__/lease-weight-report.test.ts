import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaseStatus, tryAcquireLease, type LeaseHandle, type LeaseOptions, type LeaseRefusal } from "../src/lease.js";
import type { HeadroomReading } from "../src/headroom-sampler.js";
import { formatAdmitted, formatNoSlot } from "../src/lease-messages.js";
import { resolveWeight, type GitLookup, type WeightRule } from "../src/lease-weights.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const GB = 2 ** 30;
const reading = (step: number, memsizeBytes?: number): HeadroomReading => ({
  level: "normal",
  step,
  signals: { level: "normal", freePct: 50, ...(memsizeBytes !== undefined && { memsizeBytes }) },
});

describe("weights in the lease's reports", () => {
  let tmp: string;
  let lease: ScriptedLease;
  const at = (step: number, memsize?: number): LeaseOptions => lease.opts({ headroom: scriptedHeadroomSampler(reading(step, memsize)) });
  const take = (o: LeaseOptions, weight?: number): LeaseHandle => tryAcquireLease(o, { command: "npm test", cwd: "/w", weight })!;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-weight-report-"));
    lease = scriptedLease(join(tmp, "lease"), { policy: { heavyCeiling: 4, heavyWarning: 1 }, alive: [process.pid] });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // 16 GB leaves 12 GB usable; at step 3 the budget is 9 GB and an unmatched command weighs 3 GB.
  it("reports used and budget in status, the acquire event and the admitted line, counting the unmatched weight", () => {
    const o = at(3, 16 * GB);
    take(o, 4 * GB);
    const second = take(o);
    expect(leaseStatus(o).weights).toEqual({ used: 7 * GB, budget: 9 * GB });
    expect(lease.events.filter((e) => e.type === "acquire").at(-1)).toMatchObject({ weights: { weight: 3 * GB, used: 7 * GB, budget: 9 * GB } });
    expect(formatAdmitted(second.admission)).toBe("lease: admitted after 0s (pressure=normal, 2/3 live, weights 7.0/9.0 GB)");
  });

  it("leaves weights out while the machine's memory is unknown", () => {
    const o = at(3);
    const h = take(o, 4 * GB);
    expect(leaseStatus(o)).not.toHaveProperty("weights");
    expect(h.admission).not.toHaveProperty("weights");
    expect(lease.events.at(-1)).not.toHaveProperty("weights");
    expect(formatAdmitted(h.admission)).toBe("lease: admitted after 0s (pressure=normal, 1/3 live)");
  });

  it("shows used/budget in the no-slot line only in weight mode", () => {
    const refusal: LeaseRefusal = { refused: "max-wait", waitedMs: 5000, level: "normal", live: 1 };
    const o = at(1, 16 * GB);
    take(o, 3 * GB);
    expect(formatNoSlot(refusal, leaseStatus(o))).toBe(
      `lease: no slot after 5s (pressure=normal, capacity 1, weights 3.0/3.0 GB, 1 live: ${process.pid} npm test); rerun the command — this is not a test failure`,
    );
    expect(formatNoSlot(refusal, { ...leaseStatus(o), weights: undefined })).not.toContain("weights");
  });
});

/**
 * The 2026-10-18 window: two pre-push runs, an xcodebuild and an unmatched command ask while the step climbs 1 to 4. Each request's weight
 * comes from `resolveWeight` over a rule table with an injected `GitLookup`, and Σ admitted weight must stay within the step's budget unless one holder runs alone.
 */
describe("replay of the 2026-10-18 window", () => {
  const rules: WeightRule[] = [
    { pattern: "pre-push", repo: "WXYC/Backend-Service", gb: 12 },
    { pattern: "xcodebuild", gb: 8 },
  ];
  const git: GitLookup = { toplevel: () => "/w/backend", origin: () => "git@github.com:WXYC/Backend-Service.git" };
  const requests = ["./pre-push", "./pre-push", "xcodebuild test -scheme WXYC", "make lint"];
  let tmp: string;

  beforeEach(() => void (tmp = mkdtempSync(join(tmpdir(), "lease-replay-"))));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // [machine GB, live holders after each step 1..4, oversize-alone admissions over the climb]. 16 GB leaves 12 GB usable: one pre-push runs
  // alone from step 1 and nothing else fits. 24 GB (18 usable) admits a pre-push alone at step 1 and the 4.5 GB unmatched command at step 4.
  // 64 GB (48 usable) fits every request within budget, 12 + 12 + 8 + 12 = 44 GB, one more each step.
  it.each([
    [16, [1, 1, 1, 1], 1],
    [24, [1, 1, 1, 2], 1],
    [64, [1, 2, 3, 4], 0],
  ])("keeps the admitted weight within the budget on a %i GB machine", (gb, liveByStep, oversizeAdmissions) => {
    const usable = gb * GB * 0.75;
    let step = 1;
    const lease = scriptedLease(join(tmp, `lease-${gb}`), { policy: { heavyCeiling: 4, heavyWarning: 1 }, alive: [process.pid] });
    const o = lease.opts({ headroom: scriptedHeadroomSampler(() => reading(step, gb * GB)) });
    const pending = requests.map((command) => ({ command, weight: resolveWeight(command, "/w/backend", rules, git) }));
    const admittedWeights: number[] = [];
    const liveSeen: number[] = [];
    let oversize = 0;

    for (step = 1; step <= 4; step++) {
      const budget = (usable * step) / 4;
      for (const request of [...pending]) {
        const { command, weight } = request;
        if (tryAcquireLease(o, { command, cwd: "/w/backend", ...(weight !== undefined && { weight }) })) {
          admittedWeights.push(weight ?? usable / 4);
          pending.splice(pending.indexOf(request), 1);
          if (admittedWeights.reduce((a, b) => a + b, 0) > budget * (1 + 1e-12)) oversize++;
        }
      }
      const total = admittedWeights.reduce((a, b) => a + b, 0);
      liveSeen.push(admittedWeights.length);
      expect(admittedWeights.length, `step ${step} admits a non-empty set`).toBeGreaterThan(0);
      expect(leaseStatus(o).live).toHaveLength(admittedWeights.length);
      expect(leaseStatus(o).weights).toEqual({ used: total, budget });
      expect(total <= budget * (1 + 1e-12) || admittedWeights.length === 1, `step ${step}: ${total / GB} GB of ${budget / GB} GB`).toBe(true);
    }
    expect(oversize, "oversize-alone admissions over the climb").toBeLessThanOrEqual(1);
    expect(oversize).toBe(oversizeAdmissions);
    expect(liveSeen).toEqual(liveByStep);
  });
});
