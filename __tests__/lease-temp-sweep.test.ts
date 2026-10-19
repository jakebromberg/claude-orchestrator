import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, acquireSessionLease, leaseStatus, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const DEAD = 91_111;
const LIVE = 92_222;
const meta = { command: "npm test", cwd: "/work" };

describe("orphaned writeFileAtomic temp files", () => {
  let tmp: string;
  let dir: string;
  let lease: ScriptedLease;
  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions => lease.opts({ headroom: scriptedHeadroomSampler({ level: "normal", step: 4, signals: null }), ...over });
  const plant = (sub: string, name: string): string => {
    const file = join(dir, sub, name);
    mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    writeFileSync(file, "{");
    return file;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-temp-sweep-"));
    dir = join(tmp, "lease");
    lease = scriptedLease(dir, { policy: { heavyCeiling: 4, heavyWarning: 1 }, alive: [process.pid, LIVE] });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const cases = [
    ["heavy", "holders", "4242-ab.json"],
    ["heavy", "waiting", "4242-ab.json"],
    ["heavy", "", "headroom.json"],
    ["heavy", "", "level.json"],
    ["heavy", "", "cpu.json"],
    ["heavy", "", "lastAdmit"],
    ["session", "sessions", "hook-1.json"],
    ["session", "sessions-waiting", "hook-1.json"],
  ] as const;
  const acquire = (kind: "heavy" | "session", o: LeaseOptions) =>
    (kind === "heavy" ? acquireLease(o, meta, { maxWaitMs: 0 }) : acquireSessionLease(o, meta, { maxWaitMs: 0 })) as Promise<LeaseHandle>;

  it.each(cases.map(([kind, sub, base]) => ({ kind, sub, base })))(
    "a $kind acquire removes a dead-owner $sub/$base temp and keeps a live-owner one",
    async ({ kind, sub, base }) => {
      const dead = plant(sub, `${base}.${DEAD}.0a1b2c3d.tmp`);
      const live = plant(sub, `${base}.${LIVE}.0a1b2c3d.tmp`);
      const noPid = plant(sub, `${base}.tmp`);
      const record = plant(sub, "note.txt");
      const h = await acquire(kind, opts());
      expect("leased" in h).toBe(true);
      expect([existsSync(dead), existsSync(live), existsSync(noPid), existsSync(record)]).toEqual([false, true, true, true]);
      h.release();
    },
  );

  it("leaves temp files alone in the read-only status", () => {
    const dead = plant("holders", `4242-ab.json.${DEAD}.aa.tmp`);
    const root = plant("", `headroom.json.${DEAD}.aa.tmp`);
    leaseStatus(opts());
    expect([existsSync(dead), existsSync(root)]).toEqual([true, true]);
  });
});
