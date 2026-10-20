import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
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

/** The plist's `StartInterval`, and how many missed intervals make `watchdog.json` stale in the status line. */
export const START_INTERVAL_S = 120;
export const STALE_AFTER_INTERVALS = 3;

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `node` path for the plist: the first absolute `PATH` entry whose `node` resolves to the running binary, unresolved
 * (Homebrew's `/opt/homebrew/bin/node`), so a version-specific `Cellar/<version>` path does not vanish at the next upgrade;
 * the running path when no entry matches or it cannot itself be resolved.
 */
export function stableNode(execPath: string, pathEnv: string | undefined, realpath: (p: string) => string): string {
  const real = (p: string): string | undefined => {
    try {
      return realpath(p);
    } catch {
      return undefined;
    }
  };
  const target = real(execPath);
  if (target === undefined) return execPath;
  for (const entry of (pathEnv ?? "").split(":")) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, "node");
    if (real(candidate) === target) return candidate;
  }
  return execPath;
}

/** A linked git worktree has a `.git` file whose `gitdir:` points into a `worktrees/` directory; a primary checkout, a submodule or a `--separate-git-dir` checkout does not. */
export function isGitWorktree(checkout: string): boolean {
  try {
    return /^gitdir: .*[\\/]worktrees[\\/][^\\/]+\s*$/m.test(readFileSync(join(checkout, ".git"), "utf-8"));
  } catch {
    return false;
  }
}

/** The checkout holding `dist/`, two levels above the real path of the running bin (`dist/src/cli-watchdog.js`). */
export function checkoutOf(binPath: string): string {
  return join(dirname(binPath), "../..");
}

/**
 * The LaunchAgent plist: `check` every 120 s at background priority, named by absolute path because launchd's PATH has no `node`.
 * `CO_LEASE_DIR` pins the print-time lease directory, since launchd's environment has no `CO_LEASE_DIR` or `XDG_STATE_HOME`
 * and `check` would otherwise write where the status line does not read.
 */
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

/** The global CLAUDE.md lease-section line on `suspend` and `resume`, naming the checkout's `cli-lease.js` by absolute path (the bin is not on PATH unless the package is installed globally). */
export function claudeMdLine(checkout: string): string {
  const raw = `${checkout}/dist/src/cli-lease.js`;
  const cli = /^[A-Za-z0-9_./-]+$/.test(raw) ? raw : sh(raw);
  return `- To stop a process group on purpose, run \`node ${cli} suspend <pgid> --by <who> --reason <why>\` and later \`node ${cli} resume <pgid>\`, each alone in its own Bash call; never \`kill -STOP\`, which the watchdog reports as an unexplained stop.`;
}

/** A shell fragment for a status line: prints `watchdog.brief`, the disk-full line of `brief` and a stale-`watchdog.json` line (missing, or older than `STALE_AFTER_INTERVALS` × `START_INTERVAL_S`, while the lease directory exists), each only when present. Spawns no `node`; the mtime comes from BSD `stat -f %m`, else GNU `stat -c %Y`, and the age check is skipped unless the result is all digits (it never aborts the status line). */
export function statusLineSnippet(dir: string, fraction: number): string {
  // The message is printf's format, so its only literal `%` (before " free") is doubled.
  const format = diskFullText("%s", "%.1f").replace("% free", "%% free");
  const df = `df -Pk ${sh(dir)} 2>/dev/null | awk -v d=${sh(dir)} -v f=${fraction} 'NR==2 && $2>0 && $4/$2<f {printf "${format}\\n", d, $4/$2*100}'`;
  const fix = "re-run print-plist and reload the LaunchAgent";
  const file = sh(`${dir}/watchdog.json`);
  const num = (v: string) => `case $${v} in ''|*[!0-9]*) ${v}=;; esac`;
  const read = `m=$(stat -f %m ${file} 2>/dev/null); ${num("m")}; if [ -z "$m" ]; then m=$(stat -c %Y ${file} 2>/dev/null); ${num("m")}; fi`;
  const when = `$(date -r "$m" +%H:%M 2>/dev/null || date -d "@$m" +%H:%M 2>/dev/null)`;
  const stale = `if [ -d ${sh(dir)} ]; then if [ ! -e ${file} ]; then echo "watchdog: watchdog.json is missing; ${fix}"; else ${read}; if [ -n "$m" ] && [ $(( $(date +%s) - m )) -gt ${START_INTERVAL_S * STALE_AFTER_INTERVALS} ]; then echo "watchdog: has not run since ${when}; ${fix}"; fi; fi; fi`;
  return `w=$(cat ${sh(`${dir}/watchdog.brief`)} 2>/dev/null); [ -n "$w" ] && printf '%s\\n' "$w"; ${df}; ${stale}`;
}

/** Handles `print-plist`, `print-claude-md-line` (both exit 1 from a git worktree) and `print-status-line` (exit 0); `undefined` for any other subcommand. */
export function runPrint(argv: string[], d: PrintDeps): number | undefined {
  if (argv.length !== 1) return undefined;
  const cmd = argv[0];
  if (cmd === "print-status-line") {
    d.out(statusLineSnippet(d.dir, DISK_FULL_FRACTION));
    return 0;
  }
  if (cmd !== "print-plist" && cmd !== "print-claude-md-line") return undefined;
  if (d.isWorktree(d.checkout)) {
    d.err(`watchdog: ${d.checkout} is a git worktree, and its dist is removed at cleanup; run ${cmd} from the primary checkout`);
    return 1;
  }
  d.out(cmd === "print-plist" ? plistText({ node: d.node, checkout: d.checkout, dir: d.dir }) : claudeMdLine(d.checkout));
  return 0;
}
