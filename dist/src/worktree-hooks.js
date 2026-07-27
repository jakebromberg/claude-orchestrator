// worktree-hooks.ts — reusable per-repo worktree checkout for cross-repo DAGs.
//
// `setUpWorktree`/`removeWorktree` intentionally have no universal default (the
// YAML config layer throws for them) — a config must wire how its checkouts are
// laid out on disk. This helper packages the common shape so a config's
// `hooks.ts` opts in with one call instead of copy-pasting the git plumbing:
//
//   import { deriveWorktreeHooks } from "@funlandresearch/claude-orchestrator";
//   const wt = deriveWorktreeHooks();            // ~/Developer/WXYC, per-repo base branch
//   export default { ...wt };                    // HooksOverride
//
// For each issue it locates the repo's checkout under `reposDir`, forks a branch
// off that repo's *own* base branch (derived from `origin/HEAD` and kept as the
// `origin/<default>` remote-tracking ref, so wxyc-ios-64's `master` is honored
// rather than assumed to be `main`, and the fork starts from the freshest fetched
// state rather than a possibly-stale local branch), and creates a worktree in the
// sibling `<repo>-worktrees/` directory.
import { execFileSync } from "node:child_process";
import { existsSync as fsExistsSync, mkdirSync as fsMkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
function defaultRepoOf(issue) {
    const repo = issue.repo;
    if (!repo) {
        throw new Error(`deriveWorktreeHooks: issue #${issue.number} (${issue.slug}) has no repo; ` +
            `a cross-repo worktree needs a repo. Set "repo" on the issue or pass repoOf().`);
    }
    const slash = repo.lastIndexOf("/");
    return slash >= 0 ? repo.slice(slash + 1) : repo;
}
function defaultRunGit(args, cwd) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
}
/**
 * Build the worktree lifecycle hooks (`getWorktreePath`, `getBranchName`,
 * `setUpWorktree`, `removeWorktree`) for a cross-repo config. All four agree on
 * the same path and branch derivation, so the created worktree is exactly where
 * the engine, collision check, and merge-conflict retry look for it.
 */
export function deriveWorktreeHooks(options = {}) {
    const reposDir = options.reposDir ?? path.join(homedir(), "Developer", "WXYC");
    const repoOf = options.repoOf ?? defaultRepoOf;
    const worktreeRoot = options.worktreeRoot ?? ((repoDir) => `${repoDir}-worktrees`);
    const getBranchName = options.getBranchName ?? ((issue) => `orchestrator/${issue.slug}`);
    const runGit = options.runGit ?? defaultRunGit;
    const existsSync = options.existsSync ?? fsExistsSync;
    const mkdirSync = options.mkdirSync ?? ((p) => fsMkdirSync(p, { recursive: true }));
    // origin/HEAD is identical across all issues in a repo; resolve it once.
    const baseRefCache = new Map();
    const baseBranchOf = options.baseBranchOf ??
        ((repoDir) => {
            const cached = baseRefCache.get(repoDir);
            if (cached !== undefined)
                return cached;
            let out;
            try {
                out = runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], repoDir);
            }
            catch (err) {
                throw new Error(`deriveWorktreeHooks: could not determine the base branch for ${repoDir} ` +
                    `from origin/HEAD (${err.message}). Run ` +
                    `\`git -C ${repoDir} remote set-head origin -a\`, or pass an explicit baseBranchOf.`);
            }
            const ref = out.trim(); // e.g. "origin/master"
            // Fork from the remote-tracking ref (freshest fetched state), not the
            // possibly-stale local branch of the same name.
            const startPoint = ref.startsWith("origin/") ? ref : `origin/${ref}`;
            baseRefCache.set(repoDir, startPoint);
            return startPoint;
        });
    function repoDirOf(issue) {
        return path.join(reposDir, repoOf(issue));
    }
    function worktreePathOf(issue) {
        return path.join(worktreeRoot(repoDirOf(issue)), issue.slug);
    }
    return {
        getWorktreePath(issue) {
            return worktreePathOf(issue);
        },
        getBranchName,
        async setUpWorktree(issue) {
            const repoDir = repoDirOf(issue);
            if (!existsSync(repoDir)) {
                throw new Error(`deriveWorktreeHooks: repo checkout not found: ${repoDir} ` +
                    `(for issue #${issue.number} ${issue.slug}). Clone it under ${reposDir}.`);
            }
            const base = baseBranchOf(repoDir);
            const wtRoot = worktreeRoot(repoDir);
            const wtPath = path.join(wtRoot, issue.slug);
            const branch = getBranchName(issue);
            mkdirSync(wtRoot);
            // A prior run may have left the worktree in place — reuse it. (Callers
            // that need per-run setup, e.g. installing dependencies, should wrap this
            // hook; see the README for the composition pattern.)
            if (existsSync(wtPath))
                return;
            // Clear stale registrations whose working dir was removed out-of-band;
            // otherwise `worktree add` fails with "already registered". Best effort.
            try {
                runGit(["worktree", "prune"], repoDir);
            }
            catch {
                // A prune failure shouldn't block the add attempt below.
            }
            try {
                // Fresh branch off the repo's own base.
                runGit(["worktree", "add", wtPath, "-b", branch, base], repoDir);
            }
            catch {
                try {
                    // Branch already exists — attach a worktree to it.
                    runGit(["worktree", "add", wtPath, branch], repoDir);
                }
                catch (err) {
                    // A concurrent run may have just created it — tolerate that, but
                    // surface anything else with git's own error as the cause.
                    if (!existsSync(wtPath)) {
                        throw new Error(`deriveWorktreeHooks: failed to create worktree at ${wtPath} ` +
                            `(branch ${branch} off ${base} in ${repoDir}): ${err.message}`);
                    }
                }
            }
        },
        async removeWorktree(issue) {
            const repoDir = repoDirOf(issue);
            const wtPath = path.join(worktreeRoot(repoDir), issue.slug);
            if (!existsSync(wtPath))
                return;
            try {
                runGit(["worktree", "remove", wtPath, "--force"], repoDir);
            }
            catch {
                // Best effort — a leftover worktree dir shouldn't fail the run.
            }
        },
    };
}
//# sourceMappingURL=worktree-hooks.js.map