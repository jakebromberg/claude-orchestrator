/**
 * Seed function for `claimSequentialNumber`: scans `origin/<baseBranch>` once
 * to determine the next number to issue when a domain has no recorded state.
 *
 * Returns `max(captured) + 1`, or `1` when no files match. Errors from git
 * (missing repo, unreachable origin) are swallowed and treated as empty —
 * the assumption is that a fresh project legitimately has no migrations yet.
 */
import { shellQuote } from "./shell-quote.js";
export function seedFromGit(deps, options) {
    // Best-effort fetch so we seed from the freshest origin/<baseBranch>.
    // Mirrors collision-check.ts; failures are swallowed so an unreachable
    // origin doesn't block claims (we proceed with whatever ref currently
    // points to).
    try {
        deps.runCommand(`git -C ${shellQuote(options.repoDir)} fetch origin ${shellQuote(options.baseBranch)}`);
    }
    catch {
        // ignore
    }
    let max = 0;
    for (const { dir, pattern } of options.paths) {
        const re = new RegExp(pattern);
        let raw;
        try {
            raw = deps.runCommand(`git -C ${shellQuote(options.repoDir)} ls-tree -r --name-only ${shellQuote(`origin/${options.baseBranch}`)} -- ${shellQuote(dir)}`);
        }
        catch {
            continue;
        }
        for (const line of raw.split("\n")) {
            const filePath = line.trim();
            if (!filePath)
                continue;
            const m = re.exec(filePath);
            if (!m || m[1] == null)
                continue;
            const n = Number(m[1]);
            if (Number.isFinite(n) && n > max)
                max = n;
        }
    }
    return max + 1;
}
//# sourceMappingURL=seed-from-git.js.map