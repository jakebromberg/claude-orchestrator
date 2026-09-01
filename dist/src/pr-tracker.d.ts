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
 * The `owner/repo` a PR URL points at, or `null` if `url` is not a PR URL.
 *
 * Used to address `gh pr view --repo` when the caller had no expected repo to
 * constrain the extraction with — the verification still proves the PR is open
 * on this run's branch, which is the part that catches a foreign PR.
 */
export declare function repoOfPrUrl(url: string): string | null;
