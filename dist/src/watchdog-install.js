import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diskFullText, DISK_FULL_FRACTION } from "./watchdog.js";
export const LABEL = "com.jakebromberg.claude-orchestrator-watchdog";
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A linked git worktree has a `.git` file whose `gitdir:` points into a `worktrees/` directory; a primary checkout, a submodule or a `--separate-git-dir` checkout does not. */
export function isGitWorktree(checkout) {
    try {
        return /^gitdir: .*[\\/]worktrees[\\/][^\\/]+\s*$/m.test(readFileSync(join(checkout, ".git"), "utf-8"));
    }
    catch {
        return false;
    }
}
/** The checkout holding `dist/`, two levels above the real path of the running bin (`dist/src/cli-watchdog.js`). */
export function checkoutOf(binPath) {
    return join(dirname(binPath), "../..");
}
/**
 * The LaunchAgent plist: `check` every 120 s at background priority, named by absolute path because launchd's PATH has no `node`.
 * `CO_LEASE_DIR` pins the print-time lease directory, since launchd's environment has no `CO_LEASE_DIR` or `XDG_STATE_HOME`
 * and `check` would otherwise write where the status line does not read.
 */
export function plistText(o) {
    const args = ["/usr/sbin/taskpolicy", "-b", o.node, `${o.checkout}/dist/src/cli-watchdog.js`, "check"];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CO_LEASE_DIR</key>
    <string>${xml(o.dir)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>StandardErrorPath</key>
  <string>${xml(o.dir)}/watchdog.err</string>
</dict>
</plist>`;
}
/** A shell fragment for a status line: prints `watchdog.brief` and the disk-full line of `brief`, each only when present. Spawns no `node`. */
export function statusLineSnippet(dir, fraction) {
    // The message is printf's format, so its only literal `%` (before " free") is doubled.
    const format = diskFullText("%s", "%.1f").replace("% free", "%% free");
    const df = `df -Pk ${sh(dir)} 2>/dev/null | awk -v d=${sh(dir)} -v f=${fraction} 'NR==2 && $2>0 && $4/$2<f {printf "${format}\\n", d, $4/$2*100}'`;
    return `w=$(cat ${sh(`${dir}/watchdog.brief`)} 2>/dev/null); [ -n "$w" ] && printf '%s\\n' "$w"; ${df}`;
}
/** Handles `print-plist` and `print-status-line` (exit 0, or 1 when the checkout is a git worktree); `undefined` for any other subcommand. */
export function runPrint(argv, d) {
    if (argv.length !== 1)
        return undefined;
    if (argv[0] === "print-status-line")
        d.out(statusLineSnippet(d.dir, DISK_FULL_FRACTION));
    else if (argv[0] === "print-plist") {
        if (d.isWorktree(d.checkout)) {
            d.err(`watchdog: ${d.checkout} is a git worktree, and its dist is removed at cleanup; run print-plist from the primary checkout`);
            return 1;
        }
        d.out(plistText({ node: d.node, checkout: d.checkout, dir: d.dir }));
    }
    else
        return undefined;
    return 0;
}
//# sourceMappingURL=watchdog-install.js.map