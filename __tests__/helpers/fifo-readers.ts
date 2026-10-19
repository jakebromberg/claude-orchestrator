import { join } from "node:path";
import { defaultHeadroomSampler } from "../../src/headroom-sampler.js";
import { cpuBusy } from "../../src/lease.js";
import { readLeaseRecord, readRecordDir, readRegularFile } from "../../src/lease-dir.js";
import { isHeavyHookCall } from "../../src/lease-hook.js";
import { loadWeightTable } from "../../src/lease-weights.js";
import { persistedLevel } from "../../src/memory-pressure.js";
import { runWatchdog } from "../../src/watchdog.js";

/**
 * Every reader of a lease-directory record, with the FIFO name that is planted for it and what it must return. A reader
 * that opens a FIFO blocking never returns, which a sync test cannot catch, so `fifo-child.ts` runs one row in a child
 * process that the test kills after a timeout.
 */
export const FIFO_READERS: Record<string, { file: string; expected: unknown; run: (dir: string) => unknown }> = {
  readLeaseRecord: { file: "rec.json", expected: null, run: (dir) => readLeaseRecord(dir, "rec.json") },
  readRecordDir: { file: "recs/4242.json", expected: [], run: (dir) => readRecordDir(dir, "recs") },
  "headroom.json": {
    file: "headroom.json",
    expected: 1,
    run: (dir) => {
      let reads = 0;
      defaultHeadroomSampler({ CO_LEASE_DIR: dir }, { read: () => (reads++, { level: "normal", freePct: 50 }), now: () => 1_000_000 })();
      return reads;
    },
  },
  "level.json": { file: "level.json", expected: null, run: (dir) => persistedLevel(dir) },
  "cpu.json": { file: "cpu.json", expected: null, run: (dir) => cpuBusy({ dir, cpuTimes: () => ({ idle: 10, total: 20 }) } as never, 10_000) },
  "weights.json": {
    file: "weights.json",
    expected: { rules: [], warnings: 0 },
    run: (dir) => {
      const warnings: string[] = [];
      return { rules: loadWeightTable({ CO_LEASE_DIR: dir }, (l) => warnings.push(l)), warnings: warnings.length };
    },
  },
  "CO_LEASE_WEIGHTS_FILE": {
    file: "w.json",
    expected: { rules: [], warnings: 1 },
    run: (dir) => {
      const warnings: string[] = [];
      return { rules: loadWeightTable({ CO_LEASE_WEIGHTS_FILE: join(dir, "w.json") }, (l) => warnings.push(l)), warnings: warnings.length };
    },
  },
  "CO_LEASE_PATTERNS_FILE": {
    file: "p.json",
    expected: false,
    run: (dir) => {
      const call = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "bazel test //..." } });
      return isHeavyHookCall(call, { CO_LEASE_HOOK: "on", CO_LEASE_PATTERNS_FILE: join(dir, "p.json") });
    },
  },
  readRegularFile: {
    file: "plain.json",
    expected: "threw",
    run: (dir) => {
      try {
        return readRegularFile(join(dir, "plain.json"));
      } catch {
        return "threw";
      }
    },
  },
  "watchdog.json": {
    file: "watchdog.json",
    expected: [],
    run: (dir) => {
      const out: string[] = [];
      runWatchdog(["check"], { dir, scan: () => { throw new Error("no ps"); }, now: () => 0, out: (l) => out.push(l), err: (l) => out.push(l) });
      return out;
    },
  },
  "watchdog.brief": {
    file: "watchdog.brief",
    expected: [],
    run: (dir) => {
      const out: string[] = [];
      runWatchdog(["brief"], { dir, scan: () => "", now: () => 0, out: (l) => out.push(l), err: (l) => out.push(l), statfs: () => ({ bavail: 500, blocks: 1000 }) });
      return out;
    },
  },
};
