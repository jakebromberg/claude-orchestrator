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

/** The minimal shape needed to compute a ref: a number and an optional repo. */
export interface RefLike {
  number: number;
  repo?: string;
}

/**
 * Stable identity for an issue. `defaultRepo` (a config-level fallback) fills in
 * for issues that don't declare their own `repo`.
 */
export function refOf(spec: RefLike, defaultRepo?: string): string {
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
export function normalizeDep(
  entry: number | string,
  citing: RefLike,
  defaultRepo?: string,
): string {
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
export function repoOfRef(ref: string): string | undefined {
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0) return undefined;
  const repo = ref.slice(0, hashIdx);
  return repo || undefined;
}

// A ref contains `/` and `#`, which are unsafe in a filename. Percent-encode
// them reversibly. `%` is encoded first (and decoded last) so the mapping is
// a true round-trip even for refs that already contain a percent sign.
export function encodeRefForFilename(ref: string): string {
  return ref.replace(/%/g, "%25").replace(/\//g, "%2F").replace(/#/g, "%23");
}

export function decodeRefFromFilename(encoded: string): string {
  return encoded.replace(/%23/g, "#").replace(/%2F/g, "/").replace(/%25/g, "%");
}

/**
 * Deterministic ordering for issues: by repo, then by number. Numeric (not
 * lexical) within a repo, so `#9` sorts before `#10`. `defaultRepo` resolves
 * repo-less issues so single-repo DAGs order purely numerically as before.
 */
export function compareRef(a: RefLike, b: RefLike, defaultRepo?: string): number {
  const ra = a.repo ?? defaultRepo ?? "";
  const rb = b.repo ?? defaultRepo ?? "";
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.number - b.number;
}

/**
 * Deterministic ordering for refs already in string form (`"owner/repo#N"` or a
 * bare `"N"`) — the same repo-then-number ordering as {@link compareRef}, but
 * for callers that hold refs, not `RefLike` objects (the shared topo core and
 * ship-dag's planner). Numeric within a repo (so `#9` sorts before `#10`); bare
 * refs share the empty repo and therefore order purely numerically.
 *
 * Preconditions / caveats:
 * - Assumes a numeric `#N` tail. A non-numeric tail (`"repo#gate"`) yields `NaN`,
 *   which the sort spec treats as "equal" — an unstable, meaningless order. Every
 *   engine ref satisfies this (`IssueSpec.number` is a `number`); an out-of-repo
 *   caller synthesizing non-numeric refs must not rely on their ordering.
 * - Intentionally differs from {@link compareRef} on a bare ref when a
 *   `defaultRepo` is in play: here a bare ref is the empty repo, whereas
 *   `compareRef(a, b, defaultRepo)` resolves it to `defaultRepo`. Only matters
 *   for tie-breaking a set that mixes bare and qualified refs — `computeWaves`
 *   normalizes every ref via `refOf(spec, defaultRepo)` first, so it can't arise
 *   there.
 */
export function compareRefString(a: string, b: string): number {
  const ha = a.indexOf("#");
  const hb = b.indexOf("#");
  const ra = ha >= 0 ? a.slice(0, ha) : "";
  const rb = hb >= 0 ? b.slice(0, hb) : "";
  if (ra !== rb) return ra < rb ? -1 : 1;
  return Number(ha >= 0 ? a.slice(ha + 1) : a) - Number(hb >= 0 ? b.slice(hb + 1) : b);
}
