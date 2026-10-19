import { statSync } from "node:fs";
import { diskFullText, DISK_FULL_FRACTION } from "./watchdog.js";

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

export const LABEL = "com.jakebromberg.claude-orchestrator-watchdog";

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A linked git worktree has a `.git` file where a primary checkout has a directory. */
export function isGitWorktree(checkout: string): boolean {
  try {
    return statSync(`${checkout}/.git`).isFile();
  } catch {
    return false;
  }
}

/** The LaunchAgent plist: `check` every 120 s at background priority, named by absolute path because launchd's PATH has no `node`. */
export function plistText(o: { node: string; checkout: string; dir: string }): string {
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
  <key>StartInterval</key>
  <integer>120</integer>
  <key>StandardErrorPath</key>
  <string>${xml(o.dir)}/watchdog.err</string>
</dict>
</plist>`;
}

/** A shell fragment for a status line: prints `watchdog.brief` and the disk-full line of `brief`, each only when present. Spawns no `node`. */
export function statusLineSnippet(dir: string, fraction: number): string {
  // The message is printf's format, so its only literal `%` (before " free") is doubled.
  const format = diskFullText("%s", "%.1f").replace("% free", "%% free");
  const df = `df -k ${sh(dir)} 2>/dev/null | awk -v d=${sh(dir)} -v f=${fraction} 'NR==2 && $2>0 && $4/$2<f {printf "${format}\\n", d, $4/$2*100}'`;
  return `w=$(cat ${sh(`${dir}/watchdog.brief`)} 2>/dev/null); [ -n "$w" ] && printf '%s\\n' "$w"; ${df}`;
}

/** Handles `print-plist` and `print-status-line` (exit 0, or 1 when the checkout is a git worktree); `undefined` for any other subcommand. */
export function runPrint(argv: string[], d: PrintDeps): number | undefined {
  if (argv.length !== 1) return undefined;
  if (argv[0] === "print-status-line") d.out(statusLineSnippet(d.dir, DISK_FULL_FRACTION));
  else if (argv[0] === "print-plist") {
    if (d.isWorktree(d.checkout)) {
      d.err(`watchdog: ${d.checkout} is a git worktree, and its dist is removed at cleanup; run print-plist from the primary checkout`);
      return 1;
    }
    d.out(plistText({ node: d.node, checkout: d.checkout, dir: d.dir }));
  } else return undefined;
  return 0;
}
