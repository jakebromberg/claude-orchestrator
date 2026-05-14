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
/**
 * Exported for testing. Walks up from the script's directory toward the
 * filesystem root and returns the first ancestor containing a `package.json`.
 * Returns `null` if none is found.
 */
export declare function findScriptPackageRoot(scriptPath: string): string | null;
/**
 * Exported for testing. Builds the spawn command + args for the --detach
 * respawn. A TypeScript entry point is routed through `npx tsx` because plain
 * `node` cannot load `.js` import specifiers that resolve to `.ts` files.
 * The `--prefix` points at the script's nearest package root so npx resolves
 * `tsx` from the consumer's `node_modules` rather than from the cwd's.
 */
export declare function buildDetachSpawnCommand(opts: {
    scriptPath: string;
    configName: string;
    childArgv: string[];
    nodeExecPath: string;
    findPackageRoot: (scriptPath: string) => string | null;
}): {
    command: string;
    args: string[];
};
export interface MainOptions {
    configs: Record<string, ConfigFactory>;
    argv?: string[];
    projectRoot?: string;
}
export declare function createMain(options: MainOptions): Promise<void>;
