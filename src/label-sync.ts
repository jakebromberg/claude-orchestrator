/**
 * GitHub label sync module.
 *
 * Creates an `onStatusChange` handler that syncs issue labels on
 * GitHub when orchestrator issue statuses change.
 */

import type { Issue, Status, Logger } from "./types.js";
import { addIssueLabel, removeIssueLabel, ensureLabelExists, type GitHubDeps } from "./github.js";

/** Configuration for label sync. */
export interface LabelSyncHandlerConfig {
  prefix: string;
  repo: string;
}

/** Dependencies for label sync, injectable for testing. */
export interface LabelSyncDeps extends GitHubDeps {
  logger: Logger;
}

/** Statuses that get synced as labels. */
const SYNCED_STATUSES: ReadonlySet<Status> = new Set(["running", "succeeded", "failed"]);

/**
 * Create an `onStatusChange` handler that syncs GitHub issue labels.
 *
 * On status transition:
 * - Removes the old status label (if it was a synced status)
 * - Adds the new status label (if it is a synced status)
 *
 * Label format: `{prefix}:{status}` (e.g., `orchestrator:running`).
 * Errors are non-fatal and logged as warnings.
 */
export function createLabelSyncHandler(
  config: LabelSyncHandlerConfig,
  deps: LabelSyncDeps,
): (issue: Issue, oldStatus: Status, newStatus: Status) => Promise<void> {
  // Ensure labels exist upfront (idempotent)
  for (const status of SYNCED_STATUSES) {
    try {
      ensureLabelExists(config.repo, `${config.prefix}:${status}`, deps);
    } catch {
      // Non-fatal — label creation may fail if gh is not authenticated
    }
  }

  return async (issue: Issue, oldStatus: Status, newStatus: Status): Promise<void> => {
    const repo = issue.repo ?? config.repo;

    try {
      // Remove old label
      if (SYNCED_STATUSES.has(oldStatus)) {
        removeIssueLabel(repo, issue.number, `${config.prefix}:${oldStatus}`, deps);
      }

      // Add new label
      if (SYNCED_STATUSES.has(newStatus)) {
        addIssueLabel(repo, issue.number, `${config.prefix}:${newStatus}`, deps);
      }
    } catch (err) {
      deps.logger.warn(
        `Label sync failed for #${issue.number} (${oldStatus} -> ${newStatus}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
