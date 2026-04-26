/**
 * Seed function for `claimSequentialNumber`: scans `origin/<baseBranch>` once
 * to determine the next number to issue when a domain has no recorded state.
 *
 * Returns `max(captured) + 1`, or `1` when no files match. Errors from git
 * (missing repo, unreachable origin) are swallowed and treated as empty —
 * the assumption is that a fresh project legitimately has no migrations yet.
 */
export interface SeedFromGitDeps {
    runCommand: (cmd: string) => string;
}
export interface SeedFromGitOptions {
    repoDir: string;
    baseBranch: string;
    paths: {
        dir: string;
        pattern: string;
    }[];
}
export declare function seedFromGit(deps: SeedFromGitDeps, options: SeedFromGitOptions): number;
