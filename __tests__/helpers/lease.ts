import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { LeaseEvent, LeaseOptions } from "../../src/lease.js";
import type { PressureLevel } from "../../src/memory-pressure.js";
import { scriptedPressureSampler } from "../../src/testing.js";

/** The parent env with every `CO_LEASE_*` / `CO_PRESSURE_*` scrubbed, then the isolation settings applied. */
export function isolatedLeaseEnv(leaseDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CO_LEASE_") && !k.startsWith("CO_PRESSURE_")),
  );
  return { ...env, CO_LEASE_DIR: leaseDir, CO_LEASE_SLOTS: "1", CO_PRESSURE_OVERRIDE: "critical-as-warning", ...extra };
}

/**
 * A lease directory that cannot be created, to force an I/O error: a plain file named `blocker` sits where the parent
 * directory would be, so `mkdir` fails with ENOTDIR. Safe to call twice with the same `tmp`; throws EISDIR if `blocker` is a directory.
 */
export function unwritableLeaseDir(tmp: string): string {
  const blocker = join(tmp, "blocker");
  writeFileSync(blocker, "", { flag: "a" });
  return join(blocker, "lease");
}

// Captured at load: `vi.useFakeTimers()` replaces the global `setImmediate`, which would stall the yield below.
const realSetImmediate = setImmediate;

export interface FakeLeaseClock {
  /** The injected clock, in ms. Assign or `+=` it to move time without sleeping. */
  ms: number;
  /** Runs after each `sleep` advances the clock. */
  onSleep: () => void;
  /** Every `sleep` argument, in order. */
  sleeps: number[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * A fake `now`/`sleep` pair for the lease. The clock starts at the real `Date.now()`, because holder liveness compares
 * it with kernel-set mtimes and a clock far from real time makes every planted holder stale. `sleep` advances the clock,
 * runs `onSleep`, then yields to the macrotask queue, so a lease loop that never exits fails by the per-test timeout
 * instead of hanging the run.
 */
export function fakeLeaseClock(): FakeLeaseClock {
  const clock: FakeLeaseClock = {
    ms: Date.now(),
    onSleep: () => {},
    sleeps: [],
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      clock.ms += ms;
      clock.onSleep();
      await new Promise((r) => realSetImmediate(r));
    },
  };
  return clock;
}

export interface ScriptedLease {
  /** A fresh `LeaseOptions` on the scripted pieces below; `over` wins, and an explicit `undefined` drops a field (for the real default). */
  opts(over?: Partial<LeaseOptions>): LeaseOptions;
  clock: FakeLeaseClock;
  /** PIDs `isAlive` reports live; read on every call, so adding or deleting takes effect at once. */
  alive: Set<number>;
  /** Every `onEvent` argument, in order. */
  events: LeaseEvent[];
  /** Every `warn` argument, in order. */
  warnings: string[];
}

/**
 * The one way a lease test builds `LeaseOptions`: `dir`, a scripted sampler (default `normal`; `fresh` models a stale
 * cache), a one-slot policy unless `policy` says otherwise, the fake clock's `now`/`sleep`, `isAlive` over `alive`
 * (default: this process), and `onEvent`/`warn` collectors. Forgetting one of these falls back to `Date.now` or a real
 * `process.kill(pid, 0)`, which is what this builder exists to prevent. The caller supplies `dir`, always a temp directory.
 */
export function scriptedLease(
  dir: string,
  init: { level?: PressureLevel | (() => PressureLevel); fresh?: () => PressureLevel; policy?: LeaseOptions["policy"]; alive?: number[] } = {},
): ScriptedLease {
  const clock = fakeLeaseClock();
  const alive = new Set(init.alive ?? [process.pid]);
  const events: LeaseEvent[] = [];
  const warnings: string[] = [];
  return {
    clock,
    alive,
    events,
    warnings,
    opts: (over = {}) => {
      const opts: LeaseOptions = {
        dir,
        // Present, so a spread over `defaultLeaseOptions()` drops its real headroom sampler instead of reading the real sysctl.
        headroom: undefined,
        level: scriptedPressureSampler(init.level ?? "normal", init.fresh ? { fresh: init.fresh } : {}),
        policy: init.policy ?? { heavyCeiling: 1, heavyWarning: 1 },
        isAlive: (pid) => alive.has(pid),
        now: clock.now,
        sleep: clock.sleep,
        onEvent: (e) => void events.push(e),
        warn: (m) => void warnings.push(m),
        ...over,
      };
      for (const [key, value] of Object.entries(over)) if (value === undefined) delete opts[key as keyof LeaseOptions];
      return opts;
    },
  };
}

export interface IsolatedHome {
  /** The temp directory standing in for the account's home. */
  home: string;
  /** Everything under `<home>/.local/state/claude-orchestrator` except the empty `lease` directory planted there; empty when nothing wrote. */
  stray: () => string[];
  /** Puts the state directory back to its planted shape. */
  reset: () => void;
  /** Removes the temp home and leaves the redirects in place, so late work in the worker still cannot reach the account home. */
  retire: () => void;
  /** Restores `HOME`, `XDG_STATE_HOME`, `os.userInfo` and the scrubbed `CO_LEASE_*` / `CO_PRESSURE_*` variables, and removes the temp home. */
  dispose: () => void;
}

/**
 * Sends default home resolution to a temp home: `HOME`, `XDG_STATE_HOME` and `os.userInfo().homedir` (which
 * `leaseDirectory` falls back to for an env without `HOME`, and which `HOME` does not influence) all resolve inside it.
 * The default lease directory is planted empty, because the sampler persists `level.json` only into a directory that
 * exists: a test that resolves the default directory and writes there leaves an entry `stray()` reports, on a machine
 * with or without a real lease directory. It also removes every `CO_LEASE_*` / `CO_PRESSURE_*` variable from `process.env`,
 * so an exported `CO_LEASE_DIR` cannot take a test elsewhere. The home is created under `parent`. Installed once per test file by `isolate-home.ts`.
 */
export function installIsolatedHome(parent: string = tmpdir()): IsolatedHome {
  const home = realpathSync(mkdtempSync(join(parent, "co-home-")));
  const stateDir = join(home, ".local", "state", "claude-orchestrator");
  const saved = { HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, userInfo: os.userInfo };
  const plant = (): void => {
    mkdirSync(join(stateDir, "lease"), { recursive: true });
  };

  const scrubbed = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("CO_LEASE_") || k.startsWith("CO_PRESSURE_")),
  );
  for (const key of Object.keys(scrubbed)) delete process.env[key];

  process.env.HOME = home;
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  const realUserInfo = saved.userInfo;
  os.userInfo = ((options?: { encoding: "buffer" }) => ({ ...realUserInfo(options as never), homedir: home })) as typeof os.userInfo;
  // The named `userInfo` import in `src/memory-pressure.ts` is a binding on the builtin's ESM namespace, not on `os`.
  syncBuiltinESMExports();
  plant();

  const stray = (): string[] => {
    try {
      if (!statSync(join(stateDir, "lease")).isDirectory()) return ["lease (missing)"];
    } catch {
      return ["lease (missing)"];
    }
    return readdirSync(stateDir, { recursive: true })
      .map(String)
      .filter((rel) => rel !== "lease")
      .sort();
  };

  return {
    home,
    stray,
    reset: () => {
      rmSync(stateDir, { recursive: true, force: true });
      plant();
    },
    retire: () => rmSync(home, { recursive: true, force: true }),
    dispose: () => {
      for (const key of ["HOME", "XDG_STATE_HOME"] as const) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      Object.assign(process.env, scrubbed);
      os.userInfo = saved.userInfo;
      syncBuiltinESMExports();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
