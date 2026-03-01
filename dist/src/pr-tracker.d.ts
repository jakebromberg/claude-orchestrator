/**
 * Extract the last GitHub PR URL from log content.
 * Uses the last match to avoid picking up test fixture URLs (e.g. org/repo/pull/1)
 * that appear earlier in the output.
 */
export declare function extractPrUrl(logContent: string): {
    url: string;
    number: number;
} | null;
