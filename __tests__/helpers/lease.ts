/** The parent env with every `CO_LEASE_*` / `CO_PRESSURE_*` scrubbed, then the isolation settings applied. */
export function isolatedLeaseEnv(leaseDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CO_LEASE_") && !k.startsWith("CO_PRESSURE_")),
  );
  return { ...env, CO_LEASE_DIR: leaseDir, CO_LEASE_SLOTS: "1", CO_PRESSURE_OVERRIDE: "critical-as-warning", ...extra };
}

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
      await new Promise((r) => setImmediate(r));
    },
  };
  return clock;
}
