import type { Issue, Status, IssueMetadata, Logger } from "./types.js";

export type MergeResult = "merged" | "skipped" | "failed" | "rebase-failed";

export interface MergeOptions {
  /** If true, use --admin flag to bypass branch protection. */
  admin?: boolean;
}

export interface MergeDeps {
  getStatus: (ref: string) => Status;
  getMetadata: (ref: string) => IssueMetadata;
  runCommand: (cmd: string) => string;
  logger: Logger;
  getWorktreePath?: (issue: Issue) => string;
  /**
   * Optional hook invoked when `gh pr merge` fails with a conflict error.
   * Return `{ resolved: true }` to trigger a single merge retry.
   * Errors thrown by this hook are non-fatal (logged as warnings).
   */
  onMergeConflict?: (issue: Issue, conflictFiles: string[], baseBranch: string) => Promise<{ resolved: boolean; details?: string }>;
  /**
   * Base branch for an issue's PR — its repo's own default branch (iOS forks
   * from `master`, others from `main`). Used for the intra-wave rebase and the
   * `baseBranch` passed to `onMergeConflict`. When absent, or when it returns
   * `undefined` for an issue, resolution falls back to `baseBranch` then `main`.
   * In a cross-repo run this must resolve per-repo, or the rebase targets the
   * wrong ref (e.g. an iOS PR rebased onto the nonexistent `origin/main`).
   */
  getBaseBranch?: (issue: Issue) => string | undefined;
  /** Base branch fallback when `getBaseBranch` is absent/undefined. Defaults to `"main"`. */
  baseBranch?: string;
}

function isConflictError(message: string): boolean {
  return /conflict/i.test(message);
}

/**
 * Resolve the base branch for `issue`: its repo's own default via
 * `getBaseBranch`, then the run-wide `baseBranch`, then `"main"`.
 */
function resolveBaseBranch(deps: MergeDeps, issue: Issue): string {
  return deps.getBaseBranch?.(issue) ?? deps.baseBranch ?? "main";
}

/**
 * Rebase a branch against `origin/<baseBranch>` in the given worktree.
 * Returns true on success, false on failure (with rebase --abort attempted).
 */
function rebaseBranch(
  worktreePath: string,
  baseBranch: string,
  runCommand: MergeDeps["runCommand"],
  logger: Logger,
): boolean {
  try {
    runCommand(`git -C "${worktreePath}" fetch origin ${baseBranch}`);
    runCommand(`git -C "${worktreePath}" rebase origin/${baseBranch}`);
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
 * Rebase remaining wave candidates against updated main after a successful merge.
 * Issues marked rebase-failed in `results` are skipped.
 */
function rebaseRemaining(
  sorted: Issue[],
  startIndex: number,
  results: Map<string, MergeResult>,
  deps: MergeDeps,
): void {
  if (!deps.getWorktreePath) return;

  for (let j = startIndex; j < sorted.length; j++) {
    const remaining = sorted[j];

    if (results.get(remaining.ref) === "rebase-failed") continue;

    const remainingStatus = deps.getStatus(remaining.ref);
    const remainingMetadata = deps.getMetadata(remaining.ref);
    if (remainingStatus !== "succeeded" || !remainingMetadata.prUrl) continue;

    const worktreePath = deps.getWorktreePath(remaining);
    const baseBranch = resolveBaseBranch(deps, remaining);
    deps.logger.info(`#${remaining.number}: rebasing against ${baseBranch}`);

    if (!rebaseBranch(worktreePath, baseBranch, deps.runCommand, deps.logger)) {
      deps.logger.error(`#${remaining.number}: rebase failed, skipping merge`);
      results.set(remaining.ref, "rebase-failed");
    }
  }
}

/**
 * Merge PRs for succeeded issues in wave order.
 * After each successful merge, rebases remaining candidates against updated main
 * (when getWorktreePath is provided). Returns a map of issue number to merge result.
 */
export async function mergePrs(
  issues: Issue[],
  deps: MergeDeps,
  options?: MergeOptions,
): Promise<Map<string, MergeResult>> {
  const results = new Map<string, MergeResult>();

  // Sort issues by wave for ordered merging
  const sorted = [...issues].sort((a, b) => a.wave - b.wave);

  for (let i = 0; i < sorted.length; i++) {
    const issue = sorted[i];
    const status = deps.getStatus(issue.ref);
    const metadata = deps.getMetadata(issue.ref);

    // Skip issues already marked rebase-failed
    if (results.get(issue.ref) === "rebase-failed") {
      deps.logger.info(`#${issue.number}: skipped (rebase failed)`);
      continue;
    }

    if (status !== "succeeded") {
      deps.logger.info(
        `#${issue.number}: skipped (status: ${status})`,
      );
      results.set(issue.ref, "skipped");
      continue;
    }

    if (!metadata.prUrl) {
      deps.logger.info(
        `#${issue.number}: skipped (no PR URL in metadata)`,
      );
      results.set(issue.ref, "skipped");
      continue;
    }

    const adminFlag = options?.admin ? " --admin" : "";
    const mergeCmd = `gh pr merge ${metadata.prUrl} --rebase${adminFlag}`;

    let merged = false;
    let failureMessage: string | undefined;

    try {
      deps.logger.step(`#${issue.number}: merging ${metadata.prUrl}`);
      deps.runCommand(mergeCmd);
      merged = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (isConflictError(message) && deps.onMergeConflict) {
        const baseBranch = resolveBaseBranch(deps, issue);
        let resolved = false;
        try {
          const resolution = await deps.onMergeConflict(issue, [], baseBranch);
          resolved = resolution.resolved;
        } catch (hookErr) {
          deps.logger.warn(
            `#${issue.number}: onMergeConflict hook error: ${hookErr instanceof Error ? hookErr.message : String(hookErr)}`,
          );
        }

        if (resolved) {
          try {
            deps.runCommand(mergeCmd);
            merged = true;
          } catch (retryErr) {
            failureMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          }
        } else {
          failureMessage = message;
        }
      } else {
        failureMessage = message;
      }
    }

    if (merged) {
      deps.logger.info(`#${issue.number}: merged`);
      results.set(issue.ref, "merged");
      rebaseRemaining(sorted, i + 1, results, deps);
    } else {
      deps.logger.error(`#${issue.number}: merge failed: ${failureMessage}`);
      results.set(issue.ref, "failed");
    }
  }

  return results;
}
