/**
 * Cross-worktree collision detection for sequentially-numbered files.
 *
 * The pure `detectCollisions` function compares the set of files this branch
 * added against peer worktrees and the base branch since the merge-base, and
 * reports overlaps on the captured key (typically a zero-padded number such
 * as `0056`). The I/O wrapper `gatherCollisionInputs` runs the git diffs and
 * applies the per-entry regex to produce the structured input.
 */

import { shellQuote } from "./shell-quote.js";

export interface SequentialPathEntry {
  /** Directory relative to the worktree root. */
  dir: string;
  /** Regex that matches a file path under `dir`; group 1 is the unique key. */
  pattern: string;
}

export interface AddedFile {
  /** The captured key (e.g. `"0056"`). */
  key: string;
  /** The matched file path, as reported by `git diff --name-only`. */
  path: string;
}

/** Map from entry index → list of added files in that entry's domain. */
export type EntryFileMap = Record<number, AddedFile[]>;

export interface CollisionInput {
  entries: SequentialPathEntry[];
  /** Files added by the current worktree relative to its merge-base. */
  current: EntryFileMap;
  /** Files added by each peer worktree relative to that peer's merge-base. */
  peers: Record<string, EntryFileMap>;
  /**
   * Files added on `origin/<baseBranch>` since the current worktree's
   * merge-base. Catches peers that finished, merged, and tore down their
   * worktrees during the run.
   */
  shipped: EntryFileMap;
}

export interface CollisionDetail {
  entryIndex: number;
  /** The colliding captured key. */
  key: string;
  /** The current worktree's path that holds the colliding key. */
  myFile: string;
  /** Peer worktrees that also added this key. */
  peers: { slug: string; path: string }[];
  /** Paths from `origin/<baseBranch>` that hold this key. */
  shippedFiles: string[];
}

export interface CollisionResult {
  collided: boolean;
  details: CollisionDetail[];
  /** Human-readable single-paragraph summary; goes into logs. */
  summary: string;
  /** Structured prose for retry-prompt injection (engine.ts:516). */
  output: string;
  /**
   * Suggested next safe number per entry, zero-padded to the source width.
   * `null` when keys in that entry are non-numeric.
   */
  nextSafeNumber: Record<number, string | null>;
}

export function detectCollisions(input: CollisionInput): CollisionResult {
  const details: CollisionDetail[] = [];
  const nextSafeNumber: Record<number, string | null> = {};

  for (let entryIndex = 0; entryIndex < input.entries.length; entryIndex++) {
    const myFiles = input.current[entryIndex] ?? [];
    if (myFiles.length === 0) {
      nextSafeNumber[entryIndex] = computeNextSafe(entryIndex, input);
      continue;
    }

    for (const myFile of myFiles) {
      const peers: { slug: string; path: string }[] = [];
      for (const [peerSlug, peerMap] of Object.entries(input.peers)) {
        for (const peerFile of peerMap[entryIndex] ?? []) {
          if (peerFile.key === myFile.key) {
            peers.push({ slug: peerSlug, path: peerFile.path });
          }
        }
      }

      const shippedFiles = (input.shipped[entryIndex] ?? [])
        .filter((s) => s.key === myFile.key)
        .map((s) => s.path);

      if (peers.length > 0 || shippedFiles.length > 0) {
        details.push({
          entryIndex,
          key: myFile.key,
          myFile: myFile.path,
          peers,
          shippedFiles,
        });
      }
    }

    nextSafeNumber[entryIndex] = computeNextSafe(entryIndex, input);
  }

  const collided = details.length > 0;
  const summary = renderSummary(details, nextSafeNumber, input.entries);
  const output = renderOutput(details, nextSafeNumber, input.entries);
  return { collided, details, summary, output, nextSafeNumber };
}

function computeNextSafe(entryIndex: number, input: CollisionInput): string | null {
  const observed: string[] = [];
  for (const file of input.current[entryIndex] ?? []) observed.push(file.key);
  for (const peer of Object.values(input.peers)) {
    for (const file of peer[entryIndex] ?? []) observed.push(file.key);
  }
  for (const file of input.shipped[entryIndex] ?? []) observed.push(file.key);

  if (observed.length === 0) return null;

  const numeric = observed
    .map((k) => ({ key: k, n: Number(k) }))
    .filter((x) => Number.isFinite(x.n) && /^\d+$/.test(x.key));

  if (numeric.length === 0) return null;

  const max = numeric.reduce((acc, x) => (x.n > acc.n ? x : acc), numeric[0]!);
  const next = max.n + 1;
  const width = Math.max(...observed.filter((k) => /^\d+$/.test(k)).map((k) => k.length));
  return String(next).padStart(width, "0");
}

function renderSummary(
  details: CollisionDetail[],
  nextSafeNumber: Record<number, string | null>,
  entries: SequentialPathEntry[],
): string {
  if (details.length === 0) return "No sequential-file collisions detected.";
  const lines: string[] = [];
  for (const d of details) {
    const dir = entries[d.entryIndex]?.dir ?? "<unknown>";
    const peerStr = d.peers
      .map((p) => `peer #${p.slug} (${p.path})`)
      .join(", ");
    const shippedStr = d.shippedFiles.length
      ? `origin (${d.shippedFiles.join(", ")})`
      : "";
    const sources = [peerStr, shippedStr].filter(Boolean).join(" and ");
    const next = nextSafeNumber[d.entryIndex];
    const hint = next ? ` Next safe number appears to be ${next}.` : "";
    lines.push(`Collision on ${dir} key ${d.key}: ${d.myFile} conflicts with ${sources}.${hint}`);
  }
  return lines.join(" ");
}

function renderOutput(
  details: CollisionDetail[],
  nextSafeNumber: Record<number, string | null>,
  entries: SequentialPathEntry[],
): string {
  if (details.length === 0) return "";
  const lines = ["Sequential-file collision(s) detected:"];
  for (const d of details) {
    const dir = entries[d.entryIndex]?.dir ?? "<unknown>";
    lines.push(`- ${dir}: key ${d.key}`);
    lines.push(`    your file:     ${d.myFile}`);
    for (const p of d.peers) {
      lines.push(`    peer ${p.slug}:    ${p.path}`);
    }
    for (const s of d.shippedFiles) {
      lines.push(`    on origin:     ${s}`);
    }
    const next = nextSafeNumber[d.entryIndex];
    if (next) lines.push(`    next safe number: ${next}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// I/O wrapper
// ---------------------------------------------------------------------------

export interface GatherCollisionInputsDeps {
  runCommand: (cmd: string) => string;
  existsSync: (path: string) => boolean;
  currentWorktree: string;
  peers: { slug: string; worktreePath: string }[];
  entries: SequentialPathEntry[];
  baseBranch: string;
  /** Optional logger for swallowed peer errors. */
  onPeerError?: (slug: string, err: Error) => void;
}

export function gatherCollisionInputs(
  deps: GatherCollisionInputsDeps,
): CollisionInput {
  const { runCommand, existsSync, currentWorktree, peers, entries, baseBranch } = deps;
  const compiled = entries.map((e) => ({ entry: e, regex: new RegExp(e.pattern) }));

  // Best-effort fetch — never fail the scan because origin is unreachable.
  try {
    runCommand(
      `git -C ${shellQuote(currentWorktree)} fetch origin ${shellQuote(baseBranch)}`,
    );
  } catch {
    // ignore — we proceed with whatever origin/<baseBranch> currently points to
  }

  const myMergeBase = safeMergeBase(runCommand, currentWorktree, baseBranch);
  const current: EntryFileMap = myMergeBase
    ? collectAddedByEntry(
        runCommand,
        currentWorktree,
        `${myMergeBase}..HEAD`,
        compiled,
      )
    : {};

  const shipped: EntryFileMap = myMergeBase
    ? collectAddedByEntry(
        runCommand,
        currentWorktree,
        `${myMergeBase}..origin/${baseBranch}`,
        compiled,
      )
    : {};

  const peersOut: Record<string, EntryFileMap> = {};
  for (const peer of peers) {
    if (!existsSync(peer.worktreePath)) continue;
    try {
      const peerBase = runCommand(
        `git -C ${shellQuote(peer.worktreePath)} merge-base HEAD ${shellQuote(`origin/${baseBranch}`)}`,
      ).trim();
      if (!peerBase) {
        peersOut[peer.slug] = {};
        continue;
      }
      peersOut[peer.slug] = collectAddedByEntry(
        runCommand,
        peer.worktreePath,
        `${peerBase}..HEAD`,
        compiled,
        /* throwOnError */ true,
      );
    } catch (err) {
      deps.onPeerError?.(peer.slug, err instanceof Error ? err : new Error(String(err)));
      peersOut[peer.slug] = {};
    }
  }

  return { entries, current, peers: peersOut, shipped };
}

function safeMergeBase(
  runCommand: (cmd: string) => string,
  worktree: string,
  baseBranch: string,
): string | null {
  try {
    const out = runCommand(
      `git -C ${shellQuote(worktree)} merge-base HEAD ${shellQuote(`origin/${baseBranch}`)}`,
    );
    const sha = out.trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function collectAddedByEntry(
  runCommand: (cmd: string) => string,
  worktree: string,
  range: string,
  compiled: { entry: SequentialPathEntry; regex: RegExp }[],
  throwOnError = false,
): EntryFileMap {
  const out: EntryFileMap = {};
  for (let i = 0; i < compiled.length; i++) {
    const { entry, regex } = compiled[i]!;
    let raw: string;
    try {
      raw = runCommand(
        `git -C ${shellQuote(worktree)} diff --diff-filter=A --find-renames --name-only ${shellQuote(range)} -- ${shellQuote(entry.dir)}`,
      );
    } catch (err) {
      if (throwOnError) throw err;
      out[i] = [];
      continue;
    }
    const files: AddedFile[] = [];
    for (const line of raw.split("\n")) {
      const path = line.trim();
      if (!path) continue;
      const m = regex.exec(path);
      if (!m || m[1] == null) continue;
      files.push({ key: m[1], path });
    }
    out[i] = files;
  }
  return out;
}
