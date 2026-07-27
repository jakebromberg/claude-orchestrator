import type { Issue, IssueMetadata } from "./types.js";

/**
 * Collect files changed by upstream dependency issues.
 * Walks the issue's deps array and gathers filesChanged from their metadata.
 * Returns a deduplicated, sorted list of file paths.
 */
export function getDependencyFiles(
  issue: Issue,
  allIssues: Issue[],
  getMetadata: (issueNumber: number) => IssueMetadata,
): string[] {
  const files = new Set<string>();

  for (const depNumber of issue.deps) {
    const depMeta = getMetadata(depNumber);
    if (depMeta.filesChanged) {
      for (const file of depMeta.filesChanged) {
        files.add(file);
      }
    }
  }

  return [...files].sort();
}
