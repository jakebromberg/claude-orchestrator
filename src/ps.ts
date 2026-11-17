import { basename } from "node:path";
import { execFileSync } from "node:child_process";

/** The default bound of one `ps` call. */
export const PS_TIMEOUT_MS = 2_000;
/**
 * The most stdout one `ps` call may return. Node's default is 1 MiB, which the whole table passes (`swift-frontend` rows of 13 to 69 KB among
 * thousands): a read past the cap throws, and every reader of the table (the UI-test scan, the watchdog, the reaper) would then see nothing.
 */
export const PS_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs `ps` and returns trimmed stdout; throws on failure. Bounded (`PS_TIMEOUT_MS` unless `timeoutMs`; `PS_MAX_BUFFER` of output) and stderr is discarded, so a hung `ps` cannot stall a caller and nothing writes past a `warn` seam. */
export function ps(args: string[], { timeoutMs = PS_TIMEOUT_MS }: { timeoutMs?: number } = {}): string {
  return execFileSync("ps", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: PS_MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** One `ps -o <field>= -p <pid>` value; throws on failure. */
export const psField = (pid: number, field: string, opts?: { timeoutMs?: number }): string => ps(["-o", `${field}=`, "-p", String(pid)], opts);

/** `startPid` and its parents, nearest first, at most `depth` entries; stops at pid 1 and any failure ends the walk with what it has found. */
export function psAncestors(startPid: number, depth: number): number[] {
  const found: number[] = [];
  try {
    for (let pid = startPid; found.length < depth && Number.isInteger(pid) && pid > 1; pid = Number(psField(pid, "ppid"))) {
      found.push(pid);
    }
  } catch {
    // A failed lookup ends the walk, never an error.
  }
  return found;
}

/** A PID that `kill(pid, 0)` checks as one process: `0` and negatives address a group, or every process, and `process.kill` rejects 2^31 and above. */
export const isPid = (n: unknown): boolean => Number.isInteger(n) && (n as number) > 0 && (n as number) < 2 ** 31;

/** Whether any member of process group `pgid` is alive: `kill(-pgid, 0)` finds one, or `EPERM` says one is owned by another user. A non-pid is never alive, so `-0` and negatives cannot address every process. */
export function groupAlive(pgid: number, kill: (pid: number, signal: 0) => unknown = process.kill): boolean {
  if (!isPid(pgid)) return false;
  try {
    kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Sends `signal` to process group `pgid`; false when the group is gone (`ESRCH`) or `pgid` is not a pid (nothing is sent), any other error propagates. */
export function signalGroup<S extends NodeJS.Signals>(pgid: number, signal: S, kill: (pid: number, signal: S) => unknown = process.kill): boolean {
  if (!isPid(pgid)) return false;
  try {
    kill(-pgid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

/** Whether `kill(pid, 0)` finds the process: it exists, or exists under another user (`EPERM`). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `ps` `etime`, `[[dd-]hh:]mm:ss`, in milliseconds; NaN for any other shape. */
export function parseElapsed(etime: string): number {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime);
  return m ? (((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000 : NaN;
}

/** The one process-table scan: `ps` arguments whose output `parsePsTable` reads. Callers keep their own `ps` (and timeout), so injected dependencies stay text-in. */
export const PS_TABLE_ARGS = ["-axo", "pid=,ppid=,pgid=,uid=,stat=,etime=,rss=,command="];

/** One row of the process table. */
export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** `ps` `stat`: state letter first, then flags. */
  stat: string;
  /** Time since the process started (`etime`), or NaN when the column cannot be read. */
  elapsedMs: number;
  /** Resident memory (`rss`, KiB on the wire) in bytes, or NaN when the column cannot be read. */
  rssBytes: number;
  command: string;
}

/** The rows of `PS_TABLE_ARGS` output; a line that is not a row is skipped. */
export function parsePsTable(text: string): ProcRow[] {
  return text.split("\n").flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), stat: m[5], elapsedMs: parseElapsed(m[6]), rssBytes: /^\d+$/.test(m[7]) ? Number(m[7]) * 1024 : NaN, command: m[8] }] : [];
  });
}

/** A command whose first word's basename is `claude`, the one rule of what a Claude process is (the watchdog and the unowned-memory report). */
export const isClaudeCommand = (command: string): boolean => basename(command.trim().split(/\s+/)[0]!) === "claude";

/** A command under CoreSimulator: a device's own files (`Devices/<udid>/...`) or a runtime's processes (`Volumes/...` or any `.simruntime/` root); the one rule of what a simulator process is (the unowned-memory report). */
export const isSimulatorCommand = (command: string): boolean => /\/CoreSimulator\/(Devices|Volumes)\/|\.simruntime\//.test(command);

/** The Xcode tools whose running marks a simulator as in use and a command as unsuspendable. */
export const XCODE_TOOLS = ["xcodebuild", "simctl"];

/** True when `command` runs one of `names`: the name preceded by the start, whitespace, `/` or a shell separator and followed by whitespace or the end, so a tool path with spaces still counts and `mysimctl` does not. */
export const runsTool = (command: string, names: string[]): boolean => new RegExp(`(^|[\\s/;&|(])(${names.join("|")})(\\s|$)`).test(command);

/**
 * The build tool's options that take a value, from `man xcodebuild` (each entry is written there with an argument), so a value that reads `test` (a scheme or
 * project of that name) is not the action. Flags (`-retry-tests-on-failure`, `-quiet`, ...) are not here. One table for the hook's classifier and the
 * process classifier.
 */
export const XCODEBUILD_VALUED = new RegExp(`^-(?:${[
  "project", "target", "workspace",
  "scheme", "destination", "destination-timeout",
  "configuration", "arch", "sdk",
  "enableAddressSanitizer", "enableThreadSanitizer", "enableUndefinedBehaviorSanitizer",
  "enableCodeCoverage", "testLanguage", "testRegion",
  "derivedDataPath", "resultBundlePath", "authenticationKeyPath",
  "authenticationKeyID", "authenticationKeyIssuerID", "archivePath",
  "exportPath", "exportOptionsPlist", "localizationPath",
  "exportLanguage", "xcconfig", "testProductsPath",
  "xctestrun", "testPlan", "skip-testing",
  "only-testing", "skip-test-configuration", "only-test-configuration",
  "maximum-concurrent-test-device-destinations", "maximum-concurrent-test-simulator-destinations", "parallel-testing-enabled",
  "parallel-testing-worker-count", "maximum-parallel-testing-workers", "test-timeouts-enabled",
  "default-test-execution-time-allowance", "maximum-test-execution-time-allowance", "test-iterations",
  "test-repetition-relaunch-enabled", "collect-test-diagnostics", "test-enumeration-style",
  "test-enumeration-format", "test-enumeration-output-path", "toolchain"
].join("|")})$`);

/**
 * A path prefix of a process's command line: `/` separated segments with no whitespace, except a segment that ends in `.app` or `.simruntime` (Xcode Beta
 * 2.app, iOS 27.2.simruntime), so the match cannot run across the arguments of a shell whose script contains a path.
 */
const PATH_PREFIX = String.raw`(?:\/(?:[^\s/]+|[^/]*\s[^/]*\.(?:app|simruntime)))*\/`;
const XCODEBUILD_PROCESS = new RegExp(String.raw`^(?:xcrun\s+(?:-{1,2}(?:sdk|toolchain)\s+\S+\s+|-\S+\s+)*)?(?:${PATH_PREFIX})?xcodebuild\s(.*)$`, "s");
const RUNNER_PROCESS = new RegExp(String.raw`^${PATH_PREFIX}[^\s/]*-Runner\.app\/(?:[^\s/]+\/)*[^\s/]+(?:\s|$)`);
const XCTEST_PROCESS = new RegExp(String.raw`^((?:${PATH_PREFIX})?)xctest(?:\s|$)`);
const XCODE_APP_PROCESS = new RegExp(String.raw`^(?:\/(?:[^\s/]+|[^/]*\s[^/]*\.(?:app|simruntime)))*\/Contents\/MacOS\/Xcode(?:\s|$)`);
/** A simulator platform or runtime in the path of an executable (`iPhoneSimulator.platform`, `iOS 27.2.simruntime`). */
const SIMULATOR_EXECUTABLE = /(?:Simulator\.platform|\.simruntime)\//;

/**
 * Whether a process is itself a build tool test action: its executable is `xcodebuild` (by path, or through `xcrun`, which execs it) and a `test` or
 * `test-without-building` word follows. A shell or `grep` whose command line only contains that text is not one, so a wrapper's own command line
 * (the Bash call's shell, the lease CLI naming its argv) never counts: the build tool it spawns is the process that does.
 */
export const isXcodebuildTestProcess = (command: string): boolean => {
  const m = XCODEBUILD_PROCESS.exec(command.trim());
  if (m === null) return false;
  // `ps` shows the arguments without their quotes, so a value is skipped by its option: `-scheme test build` is a build.
  const args = m[1]!.split(/\s+/);
  for (let i = 0; i < args.length; i++) {
    if (XCODEBUILD_VALUED.test(args[i]!)) i++;
    else if (args[i] === "test" || args[i] === "test-without-building") return true;
  }
  return false;
};

/**
 * Whether a process is a UI-test runner: an executable under a `*-Runner.app/` bundle (in a simulator's container or in DerivedData). Xcode.app (Cmd-U)
 * spawns no build-tool process, so a run it drives shows as this. The match is on the executable's path, not on text anywhere in the command line.
 */
export const isTestRunnerProcess = (command: string): boolean => RUNNER_PROCESS.test(command.trim());

/** Whether a process is `xctest` (by path or name). On its own it says little: a Swift gate runs `xcrun xctest <bundle>` for every XCTest bundle, all day. */
export const isXctestProcess = (command: string): boolean => XCTEST_PROCESS.test(command.trim());

/** Whether `xctest` runs from a simulator platform or runtime path (`iPhoneSimulator.platform`, `.simruntime`): a test run inside a simulator. */
const xctestInSimulator = (command: string): boolean => SIMULATOR_EXECUTABLE.test(XCTEST_PROCESS.exec(command.trim())?.[1] ?? "");

/** Whether an ancestor of `pid` in `rows` is Xcode.app's main executable (`.../Xcode*.app/Contents/MacOS/Xcode`), not a shell or helper that only names it. */
export const hasXcodeAppAncestor = (rows: ProcRow[], pid: number): boolean =>
  ancestry(rows, pid, 64).chain.some((r) => r.pid !== pid && XCODE_APP_PROCESS.test(r.command.trim()) && /\/Xcode[^/]*\.app\/Contents\/MacOS\/Xcode/.test(r.command));

/** The pids of `uid`'s tests in progress in `rows` (a build tool test action, a UI-test runner, or an `xctest` that Xcode.app owns or that runs from a simulator path; a bare `xctest` does not count), leaving out `ownPid` and its ancestors (the wrapper that is asking, and the shell that holds its command line). */
export function runningUiTestPids(rows: ProcRow[], uid: number, ownPid: number): number[] {
  const own = new Set([ownPid, ...ancestry(rows, ownPid, 64).chain.map((r) => r.pid)]);
  return rows.filter((r) => r.uid === uid && !own.has(r.pid) && (isXcodebuildTestProcess(r.command) || isTestRunnerProcess(r.command) || (isXctestProcess(r.command) && (xctestInSimulator(r.command) || hasXcodeAppAncestor(rows, r.pid))))).map((r) => r.pid);
}

/** The device UDID in a command's `CoreSimulator/Devices/<udid>/` path, else `undefined`. */
export const simulatorUdid = (command: string): string | undefined => /\/CoreSimulator\/Devices\/([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})\//i.exec(command)?.[1]?.toUpperCase();

/** The test clone's UDID in a command's `XCTestDevices/<udid>/` path (the device set only the build tool creates), else `undefined`. */
export const xcTestDeviceUdid = (command: string): string | undefined => /\/XCTestDevices\/([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})\//i.exec(command)?.[1]?.toUpperCase();

/** `pid` and its parents through `rows`, nearest first, without pid 1. `complete` is false when a link is missing from the scan or the chain is not finished within `max` rows (a loop), so a caller that guards on the chain can fail closed. */
export function ancestry<R extends Pick<ProcRow, "pid" | "ppid">>(rows: R[], pid: number, max: number): { chain: R[]; complete: boolean } {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const chain: R[] = [];
  while (pid > 1) {
    const row = byPid.get(pid);
    if (!row || chain.length >= max) return { chain, complete: false };
    chain.push(row);
    pid = row.ppid;
  }
  return { chain, complete: true };
}
