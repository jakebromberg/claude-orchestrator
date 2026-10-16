import { execFileSync } from "node:child_process";

/** Runs `ps` and returns trimmed stdout; throws on failure. Bounded (2 s unless `timeoutMs`) and stderr is discarded, so a hung `ps` cannot stall a caller and nothing writes past a `warn` seam. */
export function ps(args: string[], { timeoutMs = 2_000 }: { timeoutMs?: number } = {}): string {
  return execFileSync("ps", args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] }).trim();
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
