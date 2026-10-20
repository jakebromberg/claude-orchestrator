/**
 * Memory weights for heavy commands: a rule table (`<lease dir>/weights.json`, or `CO_LEASE_WEIGHTS_FILE`) of
 * `[{ pattern, repo?, gb }]` and one lookup the hook and the CLI share. `pattern` is an unanchored, case-sensitive
 * `RegExp` test over the command; `repo` is a normalized `owner/repo` (compared case-insensitively with the cwd's `origin`
 * remote) or, when absolute, the cwd's git toplevel. The first match wins and `gb` is GiB (`gb * 2**30`, the unit of
 * `hw.memsize`). No match, a bad table or a failed git lookup yields `undefined`, so the lease applies its unmatched weight.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { readOwnFile, readRegularFile } from "./lease-dir.js";
import { leaseDirectory } from "./memory-pressure.js";

export interface WeightRule {
  pattern: string;
  repo?: string;
  gb: number;
}

/** The cwd's git facts; each throws or returns "" when unknown. Injectable for tests. */
export interface GitLookup {
  toplevel(cwd: string): string;
  origin(cwd: string): string;
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();

export const realGit: GitLookup = {
  toplevel: (cwd) => git(cwd, ["rev-parse", "--show-toplevel"]),
  origin: (cwd) => git(cwd, ["remote", "get-url", "origin"]),
};

/** `owner/repo` from an ssh or https remote URL, with or without `.git`; `undefined` for any other shape. */
export function normalizeRemote(url: string): string | undefined {
  return /[:/]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

const validRule = (r: unknown): r is WeightRule => {
  const x = r as Partial<WeightRule> | null;
  if (typeof x !== "object" || x === null || typeof x.pattern !== "string" || !(typeof x.gb === "number" && x.gb > 0 && Number.isFinite(x.gb))) return false;
  if (x.repo !== undefined && typeof x.repo !== "string") return false;
  try {
    new RegExp(x.pattern);
    return true;
  } catch {
    return false;
  }
};

/**
 * The rules of the weights file: a missing file is silent, an unreadable or malformed one or a bad entry gives one warning, and only valid entries are kept.
 * `<lease dir>/weights.json` is read through `readOwnFile`, so one that is a symlink, FIFO, directory or another user's file is unreadable (one warning);
 * an explicit `CO_LEASE_WEIGHTS_FILE` may be a symlink and is read through `readRegularFile`.
 */
export function loadWeightTable(env: NodeJS.ProcessEnv, warn: (line: string) => void): WeightRule[] {
  let file = env.CO_LEASE_WEIGHTS_FILE;
  try {
    const dir = file ? undefined : leaseDirectory(env);
    file ||= join(dir!, "weights.json");
    // A missing file throws ENOENT, which is silent below.
    const text = dir === undefined ? readRegularFile(file) : readOwnFile(file)?.text;
    if (text === undefined) throw new Error("not a regular file this user owns");
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const rules = parsed.filter(validRule);
    if (rules.length < parsed.length) warn(`lease: ignoring ${parsed.length - rules.length} invalid entries in ${file}`);
    return rules;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") warn(`lease: ignoring weights file ${file ?? ""}: ${(e as Error).message}`);
    return [];
  }
}

/** Bytes for the first rule matching `command` (and `cwd`'s repo, when keyed); `undefined` when none does. */
export function resolveWeight(command: string, cwd: string, table: WeightRule[], lookup: GitLookup = realGit): number | undefined {
  const known = (get: () => string): string | undefined => {
    try {
      return get() || undefined;
    } catch {
      return undefined;
    }
  };
  let toplevel: string | undefined | null = null;
  let remote: string | undefined | null = null;
  for (const rule of table) {
    if (!new RegExp(rule.pattern).test(command)) continue;
    if (rule.repo !== undefined) {
      let ok: boolean;
      if (isAbsolute(rule.repo)) {
        toplevel = toplevel === null ? known(() => lookup.toplevel(cwd)) : toplevel;
        ok = toplevel === rule.repo;
      } else {
        remote = remote === null ? known(() => normalizeRemote(lookup.origin(cwd)) ?? "") : remote;
        ok = remote?.toLowerCase() === rule.repo.toLowerCase();
      }
      if (!ok) continue;
    }
    return rule.gb * 2 ** 30;
  }
  return undefined;
}

/** `lookup` answering each fact once per directory; a throw is cached as unknown (""). */
export function memoizedGit(lookup: GitLookup): GitLookup {
  const facts = new Map<string, string>();
  const once = (fact: keyof GitLookup, d: string): string => {
    const key = `${fact}\0${d}`;
    if (!facts.has(key)) {
      try {
        facts.set(key, lookup[fact](d));
      } catch {
        facts.set(key, "");
      }
    }
    return facts.get(key)!;
  };
  return { toplevel: (d) => once("toplevel", d), origin: (d) => once("origin", d) };
}

/**
 * The largest weight over `commands` in `cwd` from the table `env` names; `undefined` when none matches. One table read and at most one git call per fact per directory, because each blocks the caller's event loop.
 */
export function weightForCommands(commands: string[], cwd: string, env: NodeJS.ProcessEnv, warn: (line: string) => void, lookup: GitLookup = realGit): number | undefined {
  const table = loadWeightTable(env, warn);
  const git = memoizedGit(lookup);
  const weights = commands.map((c) => resolveWeight(c, cwd, table, git)).filter((w): w is number => w !== undefined);
  return weights.length ? Math.max(...weights) : undefined;
}

/** The weight for a command in `cwd` from the table `env` names; the one call the hook and the CLI make. */
export function weightFor(command: string, cwd: string, env: NodeJS.ProcessEnv, warn: (line: string) => void): number | undefined {
  return weightForCommands([command], cwd, env, warn);
}
