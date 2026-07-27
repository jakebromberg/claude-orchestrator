import type { Issue, IssueMetadata } from "./types.js";

/**
 * Collect files changed by upstream dependency issues.
 * Walks the issue's deps array and gathers filesChanged from their metadata.
 * Returns a deduplicated, sorted list of file paths.
 */
export function getDependencyFiles(
  issue: Issue,
  allIssues: Issue[],
  getMetadata: (ref: string) => IssueMetadata,
): string[] {
  const files = new Set<string>();

  for (const depRef of issue.deps) {
    const depMeta = getMetadata(depRef);
    if (depMeta.filesChanged) {
      for (const file of depMeta.filesChanged) {
        files.add(file);
      }
    }
  }

  return [...files].sort();
}
