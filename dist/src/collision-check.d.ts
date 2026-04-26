/**
 * Cross-worktree collision detection for sequentially-numbered files.
 *
 * The pure `detectCollisions` function compares the set of files this branch
 * added against peer worktrees and the base branch since the merge-base, and
 * reports overlaps on the captured key (typically a zero-padded number such
 * as `0056`). The I/O wrapper `gatherCollisionInputs` runs the git diffs and
 * applies the per-entry regex to produce the structured input.
 */
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
    peers: {
        slug: string;
        path: string;
    }[];
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
export declare function detectCollisions(input: CollisionInput): CollisionResult;
export interface GatherCollisionInputsDeps {
    runCommand: (cmd: string) => string;
    existsSync: (path: string) => boolean;
    currentWorktree: string;
    peers: {
        slug: string;
        worktreePath: string;
    }[];
    entries: SequentialPathEntry[];
    baseBranch: string;
    /** Optional logger for swallowed peer errors. */
    onPeerError?: (slug: string, err: Error) => void;
}
export declare function gatherCollisionInputs(deps: GatherCollisionInputsDeps): CollisionInput;
