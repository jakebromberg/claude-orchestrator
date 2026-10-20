import { sessionCapacity } from "./memory-pressure.js";
/** How long `normal` must hold before capacity returns from `warning` or `critical`. */
const HYSTERESIS_MS = 60_000;
/**
 * Turns pressure readings into a launch capacity: K (`maxParallel`) at every
 * level but `critical`, where it is 0. With `adaptive`, the shown level stays
 * at `warning` or `critical` until `normal` has held for 60 s (a debounce, not
 * a prediction), but `warning` no longer lowers capacity, so a `critical`
 * followed by a `warning` reading reopens capacity to K on that first reading;
 * only `critical` followed straight by `normal` waits out the 60 s. Without
 * `adaptive`, `warning` is ignored and there is no hysteresis, but `critical`
 * still closes capacity.
 * The first reading is taken at creation; each transition is logged once and passed to `onTransition`
 * (a callback that throws is ignored), tagged with `runId` when given.
 */
export function createCapacityGovernor(opts) {
    const { sampler, maxParallel, adaptive, logger, runId, onTransition, now = () => performance.now() } = opts;
    let held = "normal";
    let calmSince;
    let shown = "normal";
    let capacity = maxParallel;
    const tick = () => {
        const raw = sampler();
        let level = raw === "warning" && !adaptive ? "normal" : raw;
        if (adaptive) {
            if (raw === "warning" || raw === "critical") {
                held = raw;
                calmSince = undefined;
            }
            else if (held !== "normal") {
                const t = now();
                calmSince ??= t;
                if (t - calmSince >= HYSTERESIS_MS)
                    held = "normal";
            }
            if (held !== "normal")
                level = held;
        }
        capacity = sessionCapacity(level, maxParallel);
        const label = level === "unknown" ? "normal" : level;
        if (label !== shown) {
            logger.info(`Memory pressure ${shown} -> ${label}: launch capacity ${capacity}`);
            try {
                onTransition?.({ type: "capacity-transition", runId, from: shown, to: label, capacity });
            }
            catch {
                // Recording a transition must never change what the governor does.
            }
            shown = label;
        }
    };
    tick();
    return { capacity: () => capacity, tick };
}
//# sourceMappingURL=capacity-governor.js.map