/**
 * GitHub label sync module.
 *
 * Creates an `onStatusChange` handler that syncs issue labels on
 * GitHub when orchestrator issue statuses change.
 */
import type { Issue, Status, Logger } from "./types.js";
import { type GitHubDeps } from "./github.js";
/** Configuration for label sync. */
export interface LabelSyncHandlerConfig {
    prefix: string;
    repo: string;
}
/** Dependencies for label sync, injectable for testing. */
export interface LabelSyncDeps extends GitHubDeps {
    logger: Logger;
}
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
export declare function createLabelSyncHandler(config: LabelSyncHandlerConfig, deps: LabelSyncDeps): (issue: Issue, oldStatus: Status, newStatus: Status) => Promise<void>;
