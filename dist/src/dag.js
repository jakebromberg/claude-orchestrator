/**
 * Compute wave assignments from dependency declarations using topological sort.
 *
 * Issues with no dependencies get wave 1. Others get `max(wave of deps) + 1`.
 * If `ownsFiles` is set on any issue, issues within the same candidate wave
 * that claim an overlapping file (not covered by `ignoredOwnsFiles`) are slid
 * to the next wave in ascending issue-number order so that the lower-numbered
 * issue always runs first.
 * Throws if the dependency graph contains a cycle.
 */
export function computeWaves(specs, options) {
    if (specs.length === 0)
        return [];
    const byNumber = new Map();
    for (const spec of specs) {
        byNumber.set(spec.number, spec);
    }
    // Build adjacency: for each issue, track which issues depend on it
    const dependents = new Map();
    const inDegree = new Map();
    for (const spec of specs) {
        dependents.set(spec.number, []);
        inDegree.set(spec.number, spec.dependsOn.length);
    }
    for (const spec of specs) {
        for (const dep of spec.dependsOn) {
            dependents.get(dep)?.push(spec.number);
        }
    }
    // Kahn's algorithm: process nodes with in-degree 0, compute waves
    const waves = new Map();
    const queue = [];
    for (const spec of specs) {
        if (spec.dependsOn.length === 0) {
            queue.push(spec.number);
            waves.set(spec.number, 1);
        }
    }
    let processed = 0;
    while (queue.length > 0) {
        const current = queue.shift();
        processed++;
        const currentWave = waves.get(current);
        for (const dependent of dependents.get(current) ?? []) {
            // Update wave: max of all dependency waves + 1
            const existingWave = waves.get(dependent) ?? 0;
            waves.set(dependent, Math.max(existingWave, currentWave + 1));
            // Decrement in-degree
            const remaining = inDegree.get(dependent) - 1;
            inDegree.set(dependent, remaining);
            if (remaining === 0) {
                queue.push(dependent);
            }
        }
    }
    if (processed < specs.length) {
        const inCycle = specs
            .filter((s) => !waves.has(s.number) || inDegree.get(s.number) > 0)
            .map((s) => `#${s.number}`)
            .join(", ");
        throw new Error(`Dependency cycle detected among issues: ${inCycle}`);
    }
    let issues = specs.map((spec) => ({
        ...spec,
        wave: waves.get(spec.number),
        deps: spec.dependsOn,
    }));
    const ignoredFiles = new Set(options?.ignoredOwnsFiles ?? []);
    issues = splitFileConflictWaves(issues, ignoredFiles);
    return splitSerialWaves(issues);
}
/**
 * Post-process wave assignments so that no two issues in the same wave own an
 * overlapping non-ignored file. Issues are processed in ascending issue-number
 * order within each wave; the lower-numbered issue keeps its wave and the
 * conflicting higher-numbered issue slides to the next wave. Cascades until
 * the assignment is stable.
 *
 * This runs before `splitSerialWaves` so that the serial-isolation step sees
 * the already-resolved file ownership.
 */
function splitFileConflictWaves(issues, ignoredFiles) {
    if (!issues.some((i) => i.ownsFiles?.length))
        return issues;
    const waveOf = new Map(issues.map((i) => [i.number, i.wave]));
    // Upper bound: in the worst case every issue cascades to its own wave.
    const upperBound = Math.max(...issues.map((i) => i.wave)) + issues.length;
    for (let w = 1; w <= upperBound; w++) {
        const inWave = issues
            .filter((i) => waveOf.get(i.number) === w)
            .sort((a, b) => a.number - b.number);
        if (inWave.length === 0)
            continue;
        const claimed = new Set();
        for (const issue of inWave) {
            const nonIgnored = (issue.ownsFiles ?? []).filter((f) => !ignoredFiles.has(f));
            if (nonIgnored.some((f) => claimed.has(f))) {
                waveOf.set(issue.number, w + 1);
            }
            else {
                for (const f of nonIgnored)
                    claimed.add(f);
            }
        }
    }
    return issues.map((i) => ({ ...i, wave: waveOf.get(i.number) }));
}
/**
 * Post-process wave assignments so that any issue with `serial: true` runs
 * alone in its own wave. Within each base wave we keep all non-serial issues
 * grouped together (preserving max parallelism for them), then run serial
 * issues one at a time, ordered by issue number for determinism. Issues in
 * later base waves are pushed back to start after all serials in earlier base
 * waves have finished.
 *
 * This is a brute-force serialization: an issue that only depends on a
 * non-serial sibling will still wait until any serial siblings in the same
 * base wave finish. The trade-off is that callers don't have to model
 * cross-issue resource conflicts (e.g. migration filename collisions) in
 * `dependsOn`.
 */
function splitSerialWaves(issues) {
    if (!issues.some((i) => i.serial))
        return issues;
    const byBaseWave = new Map();
    for (const issue of issues) {
        const arr = byBaseWave.get(issue.wave) ?? [];
        arr.push(issue);
        byBaseWave.set(issue.wave, arr);
    }
    const baseWaveNumbers = [...byBaseWave.keys()].sort((a, b) => a - b);
    const newWaves = new Map();
    let nextWave = 1;
    for (const base of baseWaveNumbers) {
        const inWave = byBaseWave.get(base);
        const nonSerial = inWave.filter((i) => !i.serial);
        const serial = inWave
            .filter((i) => i.serial)
            .sort((a, b) => a.number - b.number);
        if (nonSerial.length > 0) {
            for (const issue of nonSerial)
                newWaves.set(issue.number, nextWave);
            nextWave++;
        }
        for (const issue of serial) {
            newWaves.set(issue.number, nextWave);
            nextWave++;
        }
    }
    return issues.map((issue) => ({ ...issue, wave: newWaves.get(issue.number) }));
}
//# sourceMappingURL=dag.js.map