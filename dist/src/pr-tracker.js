// pr-tracker.ts — recovering the PR a session opened from its transcript.
//
// A headless `claude -p` session reports the PR it opened only by printing the
// URL `gh pr create` returned, so the PR has to be scraped back out of the log.
// That makes the scrape a *guess*, and a session log is a hostile place to
// guess in: multi-megabyte transcripts carry the prompt, every tool result, and
// whole file contents, so any PR URL quoted anywhere — a CLAUDE.md citing a
// sibling repo's PR, an issue digest, a code comment — is indistinguishable
// from the one the session actually created.
//
// The scrape is therefore narrowed twice over. Here, to URLs under the issue's
// own `owner/repo`; and at the call site, by `Orchestrator.verifyPrIdentity`,
// which asks GitHub whether the surviving candidate is open on this run's
// branch before anything is recorded. This module is the cheap offline filter,
// not the proof.
const PR_URL_PATTERN = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g;
// Same shape, anchored and non-global, for classifying a single URL. Derived
// from the pattern above so the two can't drift.
const PR_URL_EXACT = new RegExp(`^${PR_URL_PATTERN.source}$`);
/**
 * Extract the GitHub PR URL a session created from its log content.
 *
 * @param logContent Raw session log (stream-json transcript).
 * @param expectedRepo The issue's own `owner/repo`. When given, only URLs under
 *   that repo are candidates — compared case-insensitively, since GitHub treats
 *   owner/repo that way and a config's `repo` need not match the casing a
 *   session happened to print. **Omitting it re-opens the cross-repo false
 *   positive this parameter exists to close**, and is supported only for
 *   single-repo callers with no repo to supply (a bare-number issue ref).
 * @returns The PR URL and number, or `null` when the log holds no PR URL for
 *   `expectedRepo`.
 *
 * Among same-repo candidates the *last* one wins: a session echoes fixture and
 * example URLs (`org/repo/pull/1`) long before it opens the real PR, so the
 * newest mention is the best available signal within a repo.
 */
export function extractPrUrl(logContent, expectedRepo) {
    const matches = [...logContent.matchAll(PR_URL_PATTERN)];
    const candidates = expectedRepo
        ? matches.filter((m) => `${m[1]}/${m[2]}`.toLowerCase() === expectedRepo.toLowerCase())
        : matches;
    if (candidates.length === 0)
        return null;
    const last = candidates[candidates.length - 1];
    return { url: last[0], number: parseInt(last[3], 10) };
}
/**
 * The `owner/repo` a PR URL points at, or `null` if `url` is not a PR URL.
 *
 * Used to address `gh pr view --repo` when the caller had no expected repo to
 * constrain the extraction with — the verification still proves the PR is open
 * on this run's branch, which is the part that catches a foreign PR.
 */
export function repoOfPrUrl(url) {
    const m = PR_URL_EXACT.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
}
//# sourceMappingURL=pr-tracker.js.map