import { refOf, normalizeDep, compareRef, compareRefString } from "./ref.js";
import { layeredTopoSort } from "./topo.js";
/**
 * Compute wave assignments from dependency declarations using topological sort.
 *
 * Issues are identified by composite ref (`owner/repo#N`, or bare `N` when no
 * repo is known), so the same number in two repos is two distinct nodes and a
 * cross-repo `dependsOn` edge is honored. Issues with no dependencies get wave
 * 1; others get `max(wave of deps) + 1`. If `ownsFiles` is set, issues within
 * the same candidate wave that claim an overlapping file (not covered by
 * `ignoredOwnsFiles`) are slid to the next wave in deterministic (repo, number)
 * order so the earlier issue always runs first.
 * Throws if the dependency graph contains a cycle.
 */
export function computeWaves(specs, options) {
    if (specs.length === 0)
        return [];
    const defaultRepo = options?.defaultRepo;
    // Compute each spec's ref and normalized deps exactly once; the wave passes
    // below read them many times, so recomputing per access would be wasteful.
    const identity = new Map(specs.map((s) => [
        s,
        { ref: refOf(s, defaultRepo), deps: s.dependsOn.map((d) => normalizeDep(d, s, defaultRepo)) },
    ]));
    const refFor = (s) => identity.get(s).ref;
    const depsFor = (s) => identity.get(s).deps;
    // The layered topological partition is the shared topo core (also used by
    // ship-dag's planner); keyed by ref, colliding numbers across repos stay
    // distinct. `computeWaves` treats any unplaced node — a cycle member, or a
    // node whose dependency is out of scope — as a hard error, matching the
    // pre-refactor Kahn behavior (validateConfig already rules out-of-scope deps
    // out upstream, so in the normal path only real cycles reach here).
    const topoNodes = specs.map((spec) => ({ ref: refFor(spec), deps: depsFor(spec) }));
    const { waves, blocked, cyclic } = layeredTopoSort(topoNodes);
    const unplaced = [...cyclic, ...blocked.map((b) => b.ref)].sort(compareRefString);
    if (unplaced.length > 0) {
        throw new Error(`Dependency cycle detected among issues: ${unplaced.join(", ")}`);
    }
    const waveOf = new Map();
    waves.forEach((layer, i) => {
        for (const ref of layer)
            waveOf.set(ref, i + 1);
    });
    let issues = specs.map((spec) => ({
        ...spec,
        wave: waveOf.get(refFor(spec)),
        ref: refFor(spec),
        deps: depsFor(spec),
    }));
    const ignoredFiles = new Set(options?.ignoredOwnsFiles ?? []);
    issues = splitFileConflictWaves(issues, ignoredFiles, defaultRepo);
    return splitSerialWaves(issues, defaultRepo);
}
/**
 * Post-process wave assignments so that no two issues in the same wave own an
 * overlapping non-ignored file. Issues are processed in deterministic (repo,
 * number) order within each wave; the earlier issue keeps its wave and the
 * conflicting later issue slides to the next wave. Cascades until stable.
 *
 * Runs before `splitSerialWaves` so the serial-isolation step sees the
 * already-resolved file ownership.
 */
function splitFileConflictWaves(issues, ignoredFiles, defaultRepo) {
    if (!issues.some((i) => i.ownsFiles?.length))
        return issues;
    const waveOf = new Map(issues.map((i) => [i.ref, i.wave]));
    // Upper bound: in the worst case every issue cascades to its own wave.
    const upperBound = Math.max(...issues.map((i) => i.wave)) + issues.length;
    for (let w = 1; w <= upperBound; w++) {
        const inWave = issues
            .filter((i) => waveOf.get(i.ref) === w)
            .sort((a, b) => compareRef(a, b, defaultRepo));
        if (inWave.length === 0)
            continue;
        const claimed = new Set();
        for (const issue of inWave) {
            const nonIgnored = (issue.ownsFiles ?? []).filter((f) => !ignoredFiles.has(f));
            if (nonIgnored.some((f) => claimed.has(f))) {
                waveOf.set(issue.ref, w + 1);
            }
            else {
                for (const f of nonIgnored)
                    claimed.add(f);
            }
        }
    }
    return issues.map((i) => ({ ...i, wave: waveOf.get(i.ref) }));
}
/**
 * Post-process wave assignments so that any issue with `serial: true` runs
 * alone in its own wave. Within each base wave we keep all non-serial issues
 * grouped together (preserving max parallelism for them), then run serial
 * issues one at a time, ordered by (repo, number) for determinism. Issues in
 * later base waves are pushed back to start after all serials in earlier base
 * waves have finished.
 */
function splitSerialWaves(issues, defaultRepo) {
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
            .sort((a, b) => compareRef(a, b, defaultRepo));
        if (nonSerial.length > 0) {
            for (const issue of nonSerial)
                newWaves.set(issue.ref, nextWave);
            nextWave++;
        }
        for (const issue of serial) {
            newWaves.set(issue.ref, nextWave);
            nextWave++;
        }
    }
    return issues.map((issue) => ({ ...issue, wave: newWaves.get(issue.ref) }));
}
//# sourceMappingURL=dag.js.map