// ref.ts — composite issue identity.
//
// An orchestrator DAG can span repositories, so a bare issue number is not a
// stable identity: `WXYC/lml#924` and `WXYC/backend#924` are different issues.
// The canonical key is a *ref*: `"<owner/repo>#<number>"` when a repo is known,
// or the bare `"<number>"` when it is not (single-repo back-compat — this keeps
// existing on-disk state filenames and numeric ordering unchanged).
//
// Pure, no I/O — the identity rules live here so every consumer (DAG, stores,
// schema, engine) derives keys the same way.
/**
 * Stable identity for an issue. `defaultRepo` (a config-level fallback) fills in
 * for issues that don't declare their own `repo`.
 */
export function refOf(spec, defaultRepo) {
    const repo = spec.repo ?? defaultRepo;
    return repo ? `${repo}#${spec.number}` : String(spec.number);
}
/**
 * Normalize one `dependsOn` entry into a dep ref, relative to the issue that
 * declares it. Accepts:
 *   - a number (`1`) or numeric string (`"1"`) → the citing issue's repo
 *   - a leading-hash ref (`"#1"`) → the citing issue's repo
 *   - a fully-qualified cross-repo ref (`"owner/repo#1"`) → used as-is
 */
export function normalizeDep(entry, citing, defaultRepo) {
    const citingRepo = citing.repo ?? defaultRepo;
    if (typeof entry === "number") {
        return citingRepo ? `${citingRepo}#${entry}` : String(entry);
    }
    const s = entry.trim();
    const hashIdx = s.indexOf("#");
    if (hashIdx >= 0) {
        const repoPart = s.slice(0, hashIdx).trim();
        const numPart = s.slice(hashIdx + 1).trim();
        const repo = repoPart || citingRepo;
        return repo ? `${repo}#${numPart}` : numPart;
    }
    // Bare numeric string: same as a number entry.
    return citingRepo ? `${citingRepo}#${s}` : s;
}
/**
 * The `owner/repo` portion of a ref, or `undefined` for a bare-number ref.
 * Two refs are cross-repo when their `repoOfRef` values differ — used to detect
 * dependency edges that cross a repository boundary.
 */
export function repoOfRef(ref) {
    const hashIdx = ref.indexOf("#");
    if (hashIdx < 0)
        return undefined;
    const repo = ref.slice(0, hashIdx);
    return repo || undefined;
}
// A ref contains `/` and `#`, which are unsafe in a filename. Percent-encode
// them reversibly. `%` is encoded first (and decoded last) so the mapping is
// a true round-trip even for refs that already contain a percent sign.
export function encodeRefForFilename(ref) {
    return ref.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/#/g, "%23");
}
export function decodeRefFromFilename(encoded) {
    return encoded.replace(/%23/g, "#").replace(/%2F/g, "/").replace(/%25/g, "%");
}
/**
 * Deterministic ordering for issues: by repo, then by number. Numeric (not
 * lexical) within a repo, so `#9` sorts before `#10`. `defaultRepo` resolves
 * repo-less issues so single-repo DAGs order purely numerically as before.
 */
export function compareRef(a, b, defaultRepo) {
    const ra = a.repo ?? defaultRepo ?? "";
    const rb = b.repo ?? defaultRepo ?? "";
    if (ra !== rb)
        return ra < rb ? -1 : 1;
    return a.number - b.number;
}
//# sourceMappingURL=ref.js.map