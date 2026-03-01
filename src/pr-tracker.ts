const PR_URL_PATTERN = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/g;

/**
 * Extract the last GitHub PR URL from log content.
 * Uses the last match to avoid picking up test fixture URLs (e.g. org/repo/pull/1)
 * that appear earlier in the output.
 */
export function extractPrUrl(logContent: string): { url: string; number: number } | null {
  const matches = [...logContent.matchAll(PR_URL_PATTERN)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return { url: last[0], number: parseInt(last[1], 10) };
}
