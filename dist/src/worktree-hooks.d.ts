import type { Issue, OrchestratorHooks } from "./types.js";
/** The subset of hooks this helper provides. Spread into a config's overrides. */
export type WorktreeHooks = Pick<OrchestratorHooks, "getWorktreePath" | "getBranchName" | "setUpWorktree" | "removeWorktree">;
export interface DeriveWorktreeHooksOptions {
    /**
     * Org directory holding all repo checkouts as siblings.
     * Default: `~/Developer/WXYC`.
     */
    reposDir?: string;
    /**
     * On-disk directory name (relative to `reposDir`) for an issue's repo.
     * Default: the segment of `issue.repo` after the last `/` — the owner is the
     * parent directory, so `WXYC/library-metadata-lookup` maps to the checkout
     * `<reposDir>/library-metadata-lookup`. Throws when the issue has no repo.
     */
    repoOf?: (issue: Issue) => string;
    /**
     * Absolute worktree root for a given repo checkout directory.
     * Default: the sibling `<repoDir>-worktrees`.
     */
    worktreeRoot?: (repoDir: string) => string;
    /**
     * Base branch new worktrees fork from, per repo checkout directory.
     * Default: derived from `git rev-parse --abbrev-ref origin/HEAD` (with the
     * `origin/` prefix stripped). Never assumes `main` — deriving is the point,
     * so wxyc-ios-64 (`master`) works alongside repos on `main`. Throws an
     * actionable error when `origin/HEAD` can't be resolved; pass an explicit
     * function to override (e.g. a `repo -> branch` lookup table).
     */
    baseBranchOf?: (repoDir: string) => string;
    /** Branch name for an issue's worktree. Default: `orchestrator/<slug>`. */
    getBranchName?: (issue: Issue) => string;
    /** Run git with an argument vector (no shell). Defaults to `execFileSync`. */
    runGit?: (args: string[], cwd: string) => string;
    existsSync?: (p: string) => boolean;
    /** Create a directory (recursively). Defaults to `fs.mkdirSync(p, {recursive}`. */
    mkdirSync?: (p: string) => void;
}
/**
 * Build the worktree lifecycle hooks (`getWorktreePath`, `getBranchName`,
 * `setUpWorktree`, `removeWorktree`) for a cross-repo config. All four agree on
 * the same path and branch derivation, so the created worktree is exactly where
 * the engine, collision check, and merge-conflict retry look for it.
 */
export declare function deriveWorktreeHooks(options?: DeriveWorktreeHooksOptions): WorktreeHooks;
