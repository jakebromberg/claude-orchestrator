/** What `print-plist` and `print-status-line` need; nothing here installs anything. */
export interface PrintDeps {
    dir: string;
    node: string;
    /** The checkout holding `dist/`, two levels above the running bin. */
    checkout: string;
    isWorktree(checkout: string): boolean;
    out(line: string): void;
    err(line: string): void;
}
export declare const LABEL = "com.jakebromberg.claude-orchestrator-watchdog";
/** A linked git worktree has a `.git` file where a primary checkout has a directory. */
export declare function isGitWorktree(checkout: string): boolean;
/** The LaunchAgent plist: `check` every 120 s at background priority, named by absolute path because launchd's PATH has no `node`. */
export declare function plistText(o: {
    node: string;
    checkout: string;
    dir: string;
}): string;
/** A shell fragment for a status line: prints `watchdog.brief` and the disk-full line of `brief`, each only when present. Spawns no `node`. */
export declare function statusLineSnippet(dir: string, fraction: number): string;
/** Handles `print-plist` and `print-status-line` (exit 0, or 1 when the checkout is a git worktree); `undefined` for any other subcommand. */
export declare function runPrint(argv: string[], d: PrintDeps): number | undefined;
