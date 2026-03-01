import type { Issue, Status, IssueMetadata, Logger } from "./types.js";

export type MergeResult = "merged" | "skipped" | "failed" | "rebase-failed";

export interface MergeOptions {
  /** If true, use --admin flag to bypass branch protection. */
  admin?: boolean;
}

export interface MergeDeps {
  getStatus: (issueNumber: number) => Status;
  getMetadata: (issueNumber: number) => IssueMetadata;
  runCommand: (cmd: string) => string;
  logger: Logger;
  getWorktreePath?: (issue: Issue) => string;
}

/**
 * Rebase a branch against origin/main in the given worktree.
 * Returns true on success, false on failure (with rebase --abort attempted).
 */
function rebaseBranch(
  worktreePath: string,
  runCommand: MergeDeps["runCommand"],
  logger: Logger,
): boolean {
  try {
    runCommand(`git -C "${worktreePath}" fetch origin main`);
    runCommand(`git -C "${worktreePath}" rebase origin/main`);
    runCommand(`git -C "${worktreePath}" push --force-with-lease`);
    return true;
  } catch {
    try {
      runCommand(`git -C "${worktreePath}" rebase --abort`);
    } catch {
      logger.warn(`rebase --abort failed for ${worktreePath}`);
    }
    return false;
  }
}

/**
 * Merge PRs for succeeded issues in wave order.
 * After each successful merge, rebases remaining candidates against updated main
 * (when getWorktreePath is provided). Returns a map of issue number to merge result.
 */
export function mergePrs(
  issues: Issue[],
  deps: MergeDeps,
  options?: MergeOptions,
): Map<number, MergeResult> {
  const results = new Map<number, MergeResult>();

  // Sort issues by wave for ordered merging
  const sorted = [...issues].sort((a, b) => a.wave - b.wave);

  for (let i = 0; i < sorted.length; i++) {
    const issue = sorted[i];
    const status = deps.getStatus(issue.number);
    const metadata = deps.getMetadata(issue.number);

    // Skip issues already marked rebase-failed
    if (results.get(issue.number) === "rebase-failed") {
      deps.logger.info(`#${issue.number}: skipped (rebase failed)`);
      continue;
    }

    if (status !== "succeeded") {
      deps.logger.info(
        `#${issue.number}: skipped (status: ${status})`,
      );
      results.set(issue.number, "skipped");
      continue;
    }

    if (!metadata.prUrl) {
      deps.logger.info(
        `#${issue.number}: skipped (no PR URL in metadata)`,
      );
      results.set(issue.number, "skipped");
      continue;
    }

    try {
      deps.logger.step(`#${issue.number}: merging ${metadata.prUrl}`);

      const adminFlag = options?.admin ? " --admin" : "";
      deps.runCommand(
        `gh pr merge ${metadata.prUrl} --rebase${adminFlag}`,
      );

      deps.logger.info(`#${issue.number}: merged`);
      results.set(issue.number, "merged");

      // Rebase remaining candidates against updated main
      if (deps.getWorktreePath) {
        for (let j = i + 1; j < sorted.length; j++) {
          const remaining = sorted[j];

          // Skip if already marked rebase-failed
          if (results.get(remaining.number) === "rebase-failed") continue;

          // Only rebase candidates that could be merged
          const remainingStatus = deps.getStatus(remaining.number);
          const remainingMetadata = deps.getMetadata(remaining.number);
          if (remainingStatus !== "succeeded" || !remainingMetadata.prUrl) continue;

          const worktreePath = deps.getWorktreePath(remaining);
          deps.logger.info(`#${remaining.number}: rebasing against main`);

          if (!rebaseBranch(worktreePath, deps.runCommand, deps.logger)) {
            deps.logger.error(`#${remaining.number}: rebase failed, skipping merge`);
            results.set(remaining.number, "rebase-failed");
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error(`#${issue.number}: merge failed: ${message}`);
      results.set(issue.number, "failed");
    }
  }

  return results;
}
