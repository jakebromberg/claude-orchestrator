/**
 * The machine-wide headroom step. `<lease dir>/headroom.json` holds `{ at, signals, step, risingSince }`, computed from
 * the raw signals with the rise hold and before any per-process override, so every process that reads it agrees and
 * no process's override reaches another. Written without a lock (the last writer wins, which can delay a rise by one
 * sample) through `writeLeaseRecord`, so a missing, symlinked or foreign lease directory gets no write. The record's
 * `sampledAt` is when a line was last appended to `<lease dir>/pressure.jsonl`, the machine-wide history.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STEP_TABLE, headroomStep, MAX_STEP } from "./headroom.js";
import { writeLeaseRecord } from "./lease-dir.js";
import { jsonlSink } from "./lease-events.js";
import { applyPressureOverride, FALLBACK_MAX_AGE_MS, freeBytes, isFresh, leaseDirectory, persistedLevel, persistLevel, readMemorySignals, warnOnce, } from "./memory-pressure.js";
const SHARE_TTL_MS = 10_000;
/** A pressure line is due this long after the last one even when nothing moved, and when free % moves this far from the previous record. */
const HEARTBEAT_MS = 60_000;
const FREE_PCT_MOVE = 5;
const LEVELS = ["normal", "warning", "critical", "unknown"];
/** `previous` for `headroomStep` from an untrusted record: a step that is an integer from 0 to 4 and a `risingSince` that is a finite number or `null`, else absent. */
function validState(p) {
    const { step, risingSince } = p;
    const ok = Number.isInteger(step) && step >= 0 && step <= MAX_STEP && (risingSince === null || Number.isFinite(risingSince));
    return ok ? { step: step, risingSince: risingSince } : undefined;
}
function validSignals(s) {
    const { level, freePct } = (s ?? {});
    return typeof level === "string" && LEVELS.includes(level) && (freePct === undefined || Number.isFinite(freePct));
}
/**
 * The one production sampler: shares the step through `headroom.json` while it is under 10 s old, else reads
 * `sysctl`, steps from the stored `step` and `risingSince` (a record as old as a full climb, `riseHoldMs` × `MAX_STEP`, is ignored, so the step starts at the target), and rewrites the file and `level.json`. A failed guarded read
 * steps from the last good reading under 60 s old (in-process, else `level.json`), and otherwise from `critical`; it is
 * not shared. `CO_PRESSURE_OVERRIDE=critical-as-warning` maps `critical` to `warning` and step 0 to 1 in this process
 * only. Each sample that changed the level, the step or free % (by 5 points) from the stored record, or that finds `sampledAt`
 * 60 s old, also appends a line to `pressure.jsonl`; `heavy` (one scan of the live heavy holders, so the two fields describe the same set) returns their `live` count and `weights` (weight mode only) for it (the sampler has no lease
 * options); each line has `type: "sample"`, and a failed scan, weighing or append is swallowed. Throws when `leaseDirectory(env)` does. `deps` exists for tests.
 */
export function defaultHeadroomSampler(env = process.env, deps = {}) {
    const { read = () => readMemorySignals(), now = Date.now, log: emit = warnOnce, table = DEFAULT_STEP_TABLE, heavy } = deps;
    const logged = new Set();
    const log = (msg) => {
        if (!logged.has(msg)) {
            logged.add(msg);
            emit(msg);
        }
    };
    const dir = leaseDirectory(env);
    const overriding = applyPressureOverride("critical", env, log) === "warning";
    let lastGood;
    let last;
    let overridden = false;
    const history = jsonlSink(dir, "pressure.jsonl", { now, warn: log });
    /** Appends a pressure line when `signals` moved from the stored record `p` or its `sampledAt` is old; returns the `sampledAt` to store. */
    const record = (p, at, signals, step) => {
        const before = p && validState(p) && validSignals(p.signals) ? { ...p.signals, step: validState(p).step } : undefined;
        const sampledAt = typeof p?.sampledAt === "number" ? p.sampledAt : undefined;
        const moved = !before || before.level !== signals.level || before.step !== step || (before.freePct !== undefined && signals.freePct !== undefined && Math.abs(before.freePct - signals.freePct) >= FREE_PCT_MOVE);
        if (!moved && sampledAt !== undefined && isFresh(sampledAt, at, HEARTBEAT_MS))
            return sampledAt;
        let found;
        try {
            found = heavy?.(step, signals);
        }
        catch {
            // The holder count and weights are optional; the line is still worth writing.
        }
        history({ type: "sample", level: signals.level, freePct: signals.freePct, freeBytes: freeBytes(signals), swapUsedBytes: signals.swapUsedBytes, step, heavyLive: found?.live, weights: found?.weights });
        return at;
    };
    const stored = () => {
        try {
            const parsed = JSON.parse(readFileSync(join(dir, "headroom.json"), "utf8"));
            return parsed && typeof parsed === "object" ? parsed : undefined;
        }
        catch {
            return undefined;
        }
    };
    const shared = () => {
        const p = stored();
        const state = p && validState(p);
        if (!p || !state || typeof p.at !== "number" || !isFresh(p.at, now(), SHARE_TTL_MS) || !validSignals(p.signals))
            return undefined;
        return { at: p.at, level: p.signals.level, signals: p.signals, ...state };
    };
    const sample = () => {
        const at = now();
        const signals = read();
        let effective;
        if (signals) {
            effective = signals;
            lastGood = { signals, at };
            persistLevel(dir, { level: signals.level, at });
        }
        else {
            log("read failed; using the last good reading, else critical");
            const level = persistedLevel(dir);
            const candidate = [lastGood, level && { signals: { level: level.level }, at: level.at }].find((r) => r && isFresh(r.at, at, FALLBACK_MAX_AGE_MS));
            effective = candidate?.signals ?? { level: "critical" };
        }
        // A step no process has refreshed for as long as a full climb takes says nothing about now: start at the target.
        const climbMs = table.riseHoldMs * MAX_STEP;
        const p = stored();
        const fromDisk = p && typeof p.at === "number" && isFresh(p.at, at, climbMs) ? validState(p) : undefined;
        const state = headroomStep(effective, fromDisk ?? (last && isFresh(last.at, at, climbMs) ? last : undefined), at, table);
        last = { at, level: effective.level, signals, ...state };
        if (signals && signals.level !== "unknown") {
            try {
                writeLeaseRecord(dir, "headroom.json", JSON.stringify({ at, signals, ...state, sampledAt: record(p, at, signals, state.step) }));
            }
            catch {
                // Sharing is best-effort; the in-process reading still serves.
            }
        }
        return last;
    };
    const serve = (m) => {
        const level = overriding && m.level === "critical" ? "warning" : m.level;
        const step = overriding && m.step === 0 ? 1 : m.step;
        overridden = level !== m.level || step !== m.step;
        if (level !== m.level)
            log("CO_PRESSURE_OVERRIDE=critical-as-warning in effect: critical reads as warning");
        return { level, step, signals: m.signals };
    };
    const sampler = () => serve(last && isFresh(last.at, now(), SHARE_TTL_MS) ? last : (last = shared() ?? sample()));
    return Object.assign(sampler, { fresh: () => serve(sample()), overridden: () => overridden });
}
/** The level a `HeadroomSampler` reads, as a `PressureSampler`: one source of truth, so `level` and `level.fresh` cannot disagree with the step. */
export function levelView(headroom) {
    return Object.assign(() => headroom().level, {
        fresh: () => headroom.fresh().level,
        overridden: () => headroom.overridden?.() === true,
    });
}
//# sourceMappingURL=headroom-sampler.js.map