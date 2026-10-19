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
/** The plist's `StartInterval`, and how many missed intervals make `watchdog.json` stale in the status line. */
export declare const START_INTERVAL_S = 120;
export declare const STALE_AFTER_INTERVALS = 3;
/** A linked git worktree has a `.git` file whose `gitdir:` points into a `worktrees/` directory; a primary checkout, a submodule or a `--separate-git-dir` checkout does not. */
export declare function isGitWorktree(checkout: string): boolean;
/** The checkout holding `dist/`, two levels above the real path of the running bin (`dist/src/cli-watchdog.js`). */
export declare function checkoutOf(binPath: string): string;
/**
 * The LaunchAgent plist: `check` every 120 s at background priority, named by absolute path because launchd's PATH has no `node`.
 * `CO_LEASE_DIR` pins the print-time lease directory, since launchd's environment has no `CO_LEASE_DIR` or `XDG_STATE_HOME`
 * and `check` would otherwise write where the status line does not read.
 */
export declare function plistText(o: {
    node: string;
    checkout: string;
    dir: string;
}): string;
/** A shell fragment for a status line: prints `watchdog.brief`, the disk-full line of `brief` and a stale-`watchdog.json` line (missing, or older than `STALE_AFTER_INTERVALS` × `START_INTERVAL_S`, while the lease directory exists), each only when present. Spawns no `node`; the mtime comes from BSD `stat -f %m`, else GNU `stat -c %Y`, and the age check is skipped unless the result is all digits (it never aborts the status line). */
export declare function statusLineSnippet(dir: string, fraction: number): string;
/** Handles `print-plist` and `print-status-line` (exit 0, or 1 when the checkout is a git worktree); `undefined` for any other subcommand. */
export declare function runPrint(argv: string[], d: PrintDeps): number | undefined;
