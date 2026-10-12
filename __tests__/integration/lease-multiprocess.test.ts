import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isolatedLeaseEnv } from "../helpers/lease.js";

/**
 * Multi-process integration test for the heavy-command lease, against the
 * built `dist/`. Real processes race for slots in a fresh mkdtemp lease
 * directory, so nothing here touches the machine's real lease directory.
 * Capacity is pinned to 1 at every pressure level (`CO_LEASE_SLOTS=1` plus
 * `CO_PRESSURE_OVERRIDE=critical-as-warning`), because the children read the
 * real sysctl; assertions use the capacity `leaseStatus` reports.
 */

const distIndex = fileURLToPath(new URL("../../dist/src/index.js", import.meta.url));
const distFileLock = fileURLToPath(new URL("../../dist/src/file-lock.js", import.meta.url));

interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runNode(script: string, env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    execFile("node", ["--input-type=module", "-e", script], { env }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: (err?.code as number | undefined) ?? 0, stdout, stderr });
    });
  });
}

const holdScript = (holdMs: number): string => `
import { acquireLease, defaultLeaseOptions, leaseStatus } from ${JSON.stringify(distIndex)};
const opts = { ...defaultLeaseOptions(), pollMs: 60 };
const handle = await acquireLease(opts, { command: "hold", cwd: process.cwd() });
const start = Date.now();
const status = leaseStatus(opts);
await new Promise((r) => setTimeout(r, ${holdMs}));
const end = Date.now();
handle.release();
console.log(JSON.stringify({ leased: handle.leased, start, end, live: status.live.length, capacity: status.capacity }));
`;

describe("lease multi-process (integration)", () => {
  let tmpDir: string;
  let leaseDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-lease-mp-"));
    leaseDir = path.join(tmpDir, "lease");
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never admits more concurrent holders than the reported capacity", async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => runNode(holdScript(120), isolatedLeaseEnv(leaseDir))));
    for (const r of runs) expect(r.code, `stderr=${r.stderr}`).toBe(0);
    const results = runs.map((r) => JSON.parse(r.stdout) as { leased: boolean; start: number; end: number; live: number; capacity: number });

    const capacity = results[0].capacity;
    expect(capacity).toBe(1);
    for (const r of results) {
      expect(r.leased).toBe(true);
      expect(r.live).toBeLessThanOrEqual(capacity);
    }
    // Peak overlap of the held intervals, computed from each child's own timestamps.
    const edges = results.flatMap((r) => [[r.start, 1], [r.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    let peak = 0;
    for (const [, delta] of edges) peak = Math.max(peak, (open += delta));
    expect(peak).toBeLessThanOrEqual(capacity);
    expect(fs.readdirSync(path.join(leaseDir, "holders"))).toEqual([]);
  }, 60_000);

  it("lets exactly one of several processes reap the same stale mutex", async () => {
    fs.mkdirSync(leaseDir);
    const lockFile = path.join(leaseDir, ".mutex");
    fs.writeFileSync(lockFile, "");
    const old = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockFile, old, old);

    const script = `
import { tryLockOnce } from ${JSON.stringify(distFileLock)};
console.log(tryLockOnce(${JSON.stringify(lockFile)}, { staleAfterMs: 10_000 }) ? "won" : "lost");
`;
    const runs = await Promise.all(Array.from({ length: 8 }, () => runNode(script, process.env)));
    for (const r of runs) expect(r.code, `stderr=${r.stderr}`).toBe(0);
    expect(runs.filter((r) => r.stdout.trim() === "won")).toHaveLength(1);
  }, 30_000);
});
