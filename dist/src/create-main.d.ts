import type { OrchestratorConfig } from "./types.js";
export type ConfigFactory = ((projectRoot: string) => OrchestratorConfig) | ((projectRoot: string) => Promise<OrchestratorConfig>);
/** Exported for testing. Builds the `gh issue create` command string with shell-safe quoting. */
export declare function buildGhIssueCreateCommand(repo: string, title: string): string;
/**
 * Exported for testing. Builds the AppleScript string for a macOS notification.
 *
 * Uses AppleScript string concatenation with `quote` to handle embedded double
 * quotes in `name`. All other shell metacharacters are safe because the caller
 * passes this string directly to `execFileSync` (no shell expansion).
 */
export declare function buildNotificationScript(name: string, message: string): string;
export interface MainOptions {
    configs: Record<string, ConfigFactory>;
    argv?: string[];
    projectRoot?: string;
}
export declare function createMain(options: MainOptions): Promise<void>;
