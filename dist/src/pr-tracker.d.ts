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
export declare function extractPrUrl(logContent: string, expectedRepo?: string): {
    url: string;
    number: number;
} | null;
/**
 * Every distinct PR URL in `logContent` for `expectedRepo`, **newest mention
 * first** — the same filter and ordering {@link extractPrUrl} applies, but
 * without collapsing to a single guess.
 *
 * `extractPrUrl` returns only the newest mention, which is right when the real
 * PR is the last thing a session prints but wrong whenever anything prints a
 * same-repo PR URL after `gh pr create`. That is not hypothetical: the log is
 * opened for *append*, so a check-failure retry re-emits the whole prompt —
 * including the `UPSTREAM_CONTEXT` gathered from upstream worktrees' handoff
 * notes, which routinely cite the upstream issue's own PR in the same repo. A
 * single-guess scrape hands that to the verifier, the verifier correctly
 * rejects it (wrong head branch), and the run's genuine PR is dropped.
 *
 * Callers should therefore verify candidates in order and take the first that
 * proves to be theirs, rather than treating one failure as final.
 *
 * Duplicates are collapsed (first occurrence in newest-first order wins), so a
 * URL quoted N times costs one verification, not N.
 */
export declare function extractPrUrlCandidates(logContent: string, expectedRepo?: string): Array<{
    url: string;
    number: number;
}>;
/**
 * The `owner/repo` a PR URL points at, or `null` if `url` is not a PR URL.
 *
 * Used to address `gh pr view --repo` when the caller had no expected repo to
 * constrain the extraction with — the verification still proves the PR is open
 * on this run's branch, which is the part that catches a foreign PR.
 */
export declare function repoOfPrUrl(url: string): string | null;
