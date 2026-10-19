import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diskFullText, DISK_FULL_FRACTION } from "./watchdog.js";
export const LABEL = "com.jakebromberg.claude-orchestrator-watchdog";
/** The plist's `StartInterval`, and how many missed intervals make `watchdog.json` stale in the status line. */
export const START_INTERVAL_S = 120;
export const STALE_AFTER_INTERVALS = 3;
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
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${START_INTERVAL_S}</integer>
  <key>StandardErrorPath</key>
  <string>${xml(o.dir)}/watchdog.err</string>
</dict>
</plist>`;
}
/** A shell fragment for a status line: prints `watchdog.brief`, the disk-full line of `brief` and a stale-`watchdog.json` line (missing, or older than `STALE_AFTER_INTERVALS` × `START_INTERVAL_S`, while the lease directory exists), each only when present. Spawns no `node`; the mtime comes from BSD `stat -f %m`, else GNU `stat -c %Y`, and the age check is skipped unless the result is all digits (it never aborts the status line). */
export function statusLineSnippet(dir, fraction) {
    // The message is printf's format, so its only literal `%` (before " free") is doubled.
    const format = diskFullText("%s", "%.1f").replace("% free", "%% free");
    const df = `df -Pk ${sh(dir)} 2>/dev/null | awk -v d=${sh(dir)} -v f=${fraction} 'NR==2 && $2>0 && $4/$2<f {printf "${format}\\n", d, $4/$2*100}'`;
    const fix = "re-run print-plist and reload the LaunchAgent";
    const file = sh(`${dir}/watchdog.json`);
    const num = (v) => `case $${v} in ''|*[!0-9]*) ${v}=;; esac`;
    const read = `m=$(stat -f %m ${file} 2>/dev/null); ${num("m")}; if [ -z "$m" ]; then m=$(stat -c %Y ${file} 2>/dev/null); ${num("m")}; fi`;
    const when = `$(date -r "$m" +%H:%M 2>/dev/null || date -d "@$m" +%H:%M 2>/dev/null)`;
    const stale = `if [ -d ${sh(dir)} ]; then if [ ! -e ${file} ]; then echo "watchdog: watchdog.json is missing; ${fix}"; else ${read}; if [ -n "$m" ] && [ $(( $(date +%s) - m )) -gt ${START_INTERVAL_S * STALE_AFTER_INTERVALS} ]; then echo "watchdog: has not run since ${when}; ${fix}"; fi; fi; fi`;
    return `w=$(cat ${sh(`${dir}/watchdog.brief`)} 2>/dev/null); [ -n "$w" ] && printf '%s\\n' "$w"; ${df}; ${stale}`;
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