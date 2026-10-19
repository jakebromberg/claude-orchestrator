/**
 * Memory weights for heavy commands: a rule table (`<lease dir>/weights.json`, or `CO_LEASE_WEIGHTS_FILE`) of
 * `[{ pattern, repo?, gb }]` and one lookup the hook and the CLI share. `pattern` is an unanchored, case-sensitive
 * `RegExp` test over the command; `repo` is a normalized `owner/repo` (compared case-insensitively with the cwd's `origin`
 * remote) or, when absolute, the cwd's git toplevel. The first match wins and `gb` is GiB (`gb * 2**30`, the unit of
 * `hw.memsize`). No match, a bad table or a failed git lookup yields `undefined`, so the lease applies its unmatched weight.
 */
import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { readLeaseRecord, readRegularFile } from "./lease-dir.js";
import { leaseDirectory } from "./memory-pressure.js";
const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
export const realGit = {
    toplevel: (cwd) => git(cwd, ["rev-parse", "--show-toplevel"]),
    origin: (cwd) => git(cwd, ["remote", "get-url", "origin"]),
};
/** `owner/repo` from an ssh or https remote URL, with or without `.git`; `undefined` for any other shape. */
export function normalizeRemote(url) {
    return /[:/]([^/:\s]+\/[^/:\s]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}
const validRule = (r) => {
    const x = r;
    if (typeof x !== "object" || x === null || typeof x.pattern !== "string" || !(typeof x.gb === "number" && x.gb > 0 && Number.isFinite(x.gb)))
        return false;
    if (x.repo !== undefined && typeof x.repo !== "string")
        return false;
    try {
        new RegExp(x.pattern);
        return true;
    }
    catch {
        return false;
    }
};
/** The rules of the weights file: a missing file is silent, an unreadable or malformed one or a bad entry gives one warning, and only valid entries are kept. */
export function loadWeightTable(env, warn) {
    let file = env.CO_LEASE_WEIGHTS_FILE;
    try {
        const dir = file ? undefined : leaseDirectory(env);
        file ||= join(dir, "weights.json");
        const text = dir === undefined ? readRegularFile(file) : readLeaseRecord(dir, "weights.json")?.text;
        if (text === undefined)
            return [];
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            throw new Error("not an array");
        const rules = parsed.filter(validRule);
        if (rules.length < parsed.length)
            warn(`lease: ignoring ${parsed.length - rules.length} invalid entries in ${file}`);
        return rules;
    }
    catch (e) {
        if (e.code !== "ENOENT")
            warn(`lease: ignoring weights file ${file ?? ""}: ${e.message}`);
        return [];
    }
}
/** Bytes for the first rule matching `command` (and `cwd`'s repo, when keyed); `undefined` when none does. */
export function resolveWeight(command, cwd, table, lookup = realGit) {
    const known = (get) => {
        try {
            return get() || undefined;
        }
        catch {
            return undefined;
        }
    };
    let toplevel = null;
    let remote = null;
    for (const rule of table) {
        if (!new RegExp(rule.pattern).test(command))
            continue;
        if (rule.repo !== undefined) {
            let ok;
            if (isAbsolute(rule.repo)) {
                toplevel = toplevel === null ? known(() => lookup.toplevel(cwd)) : toplevel;
                ok = toplevel === rule.repo;
            }
            else {
                remote = remote === null ? known(() => normalizeRemote(lookup.origin(cwd)) ?? "") : remote;
                ok = remote?.toLowerCase() === rule.repo.toLowerCase();
            }
            if (!ok)
                continue;
        }
        return rule.gb * 2 ** 30;
    }
    return undefined;
}
/** The weight for a command in `cwd` from the table `env` names; the one call the hook and the CLI make. */
export function weightFor(command, cwd, env, warn) {
    return resolveWeight(command, cwd, loadWeightTable(env, warn));
}
//# sourceMappingURL=lease-weights.js.map