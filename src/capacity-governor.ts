import { sessionCapacity } from "./memory-pressure.js";
import type { PressureLevel, PressureSampler } from "./memory-pressure.js";
import type { Logger } from "./types.js";

/** How long `normal` must hold before capacity returns from `warning` or `critical`. */
const HYSTERESIS_MS = 60_000;

export interface CapacityGovernor {
  /** Launch capacity as of the last `tick`: how many pipelines may hold a pool slot (see {@link sessionCapacity}). */
  capacity(): number;
  /** Re-read the sampler and update `capacity()`. */
  tick(): void;
}

/**
 * Turns pressure readings into a launch capacity. With `adaptive`, capacity
 * stays at the lower value after `warning` or `critical` until `normal` has
 * held for 60 s (a debounce, not a prediction). Without it, `warning` is
 * ignored and there is no hysteresis, but `critical` still closes capacity.
 * The first reading is taken at creation; each transition is logged once.
 */
export function createCapacityGovernor(opts: {
  sampler: PressureSampler;
  maxParallel: number;
  adaptive: boolean;
  logger: Logger;
  /** Monotonic milliseconds, used to time the 60 s hysteresis. Defaults to `performance.now()`; do not inject `Date.now`, since a backward wall-clock step would stretch the hold. */
  now?: () => number;
}): CapacityGovernor {
  const { sampler, maxParallel, adaptive, logger, now = () => performance.now() } = opts;
  let held: PressureLevel = "normal";
  let calmSince: number | undefined;
  let shown: PressureLevel = "normal";
  let capacity = maxParallel;

  const tick = (): void => {
    const raw = sampler();
    let level: PressureLevel = raw === "warning" && !adaptive ? "normal" : raw;
    if (adaptive) {
      if (raw === "warning" || raw === "critical") {
        held = raw;
        calmSince = undefined;
      } else if (held !== "normal") {
        const t = now();
        calmSince ??= t;
        if (t - calmSince >= HYSTERESIS_MS) held = "normal";
      }
      if (held !== "normal") level = held;
    }
    capacity = sessionCapacity(level, maxParallel);
    const label = level === "unknown" ? "normal" : level;
    if (label !== shown) {
      logger.info(`Memory pressure ${shown} -> ${label}: launch capacity ${capacity}`);
      shown = label;
    }
  };

  tick();
  return { capacity: () => capacity, tick };
}
