/**
 * The lease CLI's run function and its dependency seam, with no load-time work so
 * other modules can import it. `cli-lease.ts` (the bin, which runs a startup check
 * at load) re-exports these names and must never be imported by the library.
 *
 * Pure helpers (`parseLeaseArgs`, `runLeased`, `runStatus`) take every external
 * interaction through `LeaseCliDeps`; `cliLeaseDeps` wires real I/O.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { weightFor } from "./lease-weights.js";
import { acquireLease, defaultLeaseOptions, leaseStatus, SUSPEND_MIN_RUN_MS, suspendNewest } from "./lease.js";
import { formatAdmitted, formatRefusal, refusalExitCode, seconds, throttledProgress } from "./lease-messages.js";
import { psAncestors, psField, signalGroup } from "./ps.js";
import { sampleUnowned } from "./unowned-memory.js";
import { readSuspensions, removeSuspension } from "./suspensions.js";
const DEFAULT_MAX_WAIT_SEC = 100;
const ANCESTOR_DEPTH = 32;
const GRACE_MS = 10_000;
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
const TASKPOLICY = "/usr/sbin/taskpolicy";
const EX_CONFIG = 78;
const GOVERN_MS = 2_000;
/** Commands whose work runs outside their own process group, so SIGSTOP would pause only the client (heavy-queue's `UNSUSPENDABLE`). */
const NEVER_SUSPEND = /(^|[\s/;&|(])(xcodebuild|simctl|docker|podman|ssh)(\s|$)/;
function parseSeconds(text) {
    const n = Number(text);
    return text !== undefined && text.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
export function parseLeaseArgs(argv) {
    if (argv[0] && !argv[0].startsWith("-")) {
        if (argv[0] !== "status")
            throw new Error(`Unknown subcommand: ${argv[0]}`);
        if (argv.length > 1)
            throw new Error("status takes no arguments");
        return { kind: "status" };
    }
    let maxWaitSec;
    let label;
    const value = (i, flag) => {
        const v = argv[i + 1];
        if (v === undefined || v === "")
            throw new Error(`${flag} requires an argument`);
        return v;
    };
    for (let i = 0; i < argv.length; i += 2) {
        const arg = argv[i];
        if (arg === "--") {
            if (i + 1 >= argv.length)
                throw new Error("no command after --");
            return { kind: "run", maxWaitSec, label, argv: argv.slice(i + 1) };
        }
        if (arg === "--shell") {
            const shell = value(i, "--shell");
            if (i + 2 !== argv.length)
                throw new Error("--shell must be the last argument");
            return { kind: "run", maxWaitSec, label, shell };
        }
        if (arg === "--max-wait") {
            if (maxWaitSec !== undefined)
                throw new Error("--max-wait given more than once");
            maxWaitSec = parseSeconds(value(i, "--max-wait"));
            if (maxWaitSec === undefined)
                throw new Error("--max-wait must be a number of seconds, 0 or more");
        }
        else if (arg === "--label") {
            if (label !== undefined)
                throw new Error("--label given more than once");
            label = value(i, "--label");
        }
        else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    throw new Error("a command is required: -- <cmd> [args...] or --shell '<command line>'");
}
function optionsOrReport(d) {
    try {
        return d.leaseOptions();
    }
    catch (err) {
        d.err(`lease: ${err.message}`);
        return undefined;
    }
}
/** The id of a live hook holder (`expiresAt` set) whose session PID is one of this CLI's ancestors; `undefined` when none or the ancestors are unreadable. */
function ancestorHookSlot(opts, d) {
    try {
        // Read the holders first, so a CLI start with no live hook holder spawns no `ps`.
        const hooks = d.leaseStatus(opts).live.filter((h) => h.expiresAt !== undefined);
        if (hooks.length === 0)
            return undefined;
        const up = new Set(d.ancestors());
        return hooks.find((h) => up.has(h.pid))?.id;
    }
    catch {
        return undefined;
    }
}
export function runStatus(d) {
    const opts = optionsOrReport(d);
    if (!opts)
        return EX_CONFIG;
    const { level, capacity, live, weights, sessions } = d.leaseStatus(opts);
    const unowned = d.unowned?.(opts, (sessions?.live ?? []).map((h) => h.pid), live.flatMap((h) => h.childPid ?? []));
    const holders = live.map((h) => ({ pid: h.pid, command: h.command, ageSec: h.ageSec, ...(h.override && { override: true }) }));
    d.out(`${JSON.stringify({ level, capacity, live: holders, ...(weights && { weights }), ...(unowned && { unowned }) }, null, 2)}\n`);
    return 0;
}
/** Waits for a slot, runs the command with it held, and returns the exit code to pass through. */
export async function runLeased(args, d) {
    const opts = optionsOrReport(d);
    if (!opts)
        return EX_CONFIG;
    const envWait = d.env.CO_LEASE_MAX_WAIT || undefined;
    const fromEnv = parseSeconds(envWait);
    if (envWait !== undefined && fromEnv === undefined && args.maxWaitSec === undefined) {
        d.err(`lease: ignoring invalid CO_LEASE_MAX_WAIT=${JSON.stringify(envWait)}; using ${DEFAULT_MAX_WAIT_SEC}s`);
    }
    const maxWaitMs = (args.maxWaitSec ?? fromEnv ?? DEFAULT_MAX_WAIT_SEC) * 1000;
    const [cmd, cmdArgs] = args.shell !== undefined ? ["/bin/sh", ["-c", args.shell]] : [args.argv[0], args.argv.slice(1)];
    const [file, fileArgs] = args.background ? [TASKPOLICY, ["-b", cmd, ...cmdArgs]] : [cmd, cmdArgs];
    const ownHolder = args.gated || args.background || args.suspendable;
    const command = args.shell ?? args.argv.join(" ");
    const suspendable = args.suspendable && !args.noSuspend && d.env.HEAVY_QUEUE_NO_SUSPEND !== "1" && !NEVER_SUSPEND.test(command);
    // A background child leads its own group (pid = pgid), so a signal goes to the group, continued first in case it is stopped.
    const signalChild = (sig) => {
        if (!args.background || child.pid === undefined)
            return void child.kill(sig);
        for (const s of ["SIGCONT", sig]) {
            try {
                signalGroup(child.pid, s, d.signals.kill);
            }
            catch {
                // signalGroup returns false for a vanished group; this catches any other error (such as EPERM), which is ignored.
            }
        }
    };
    // Installed before acquiring: a signal's default action would otherwise kill the wrapper between the holder file's
    // write and the spawn, leaving a slot that no child holds. A handler can only run while waiting (nothing is held, so
    // the signal is re-raised to kill the wrapper as before) or once the child exists, never in between.
    let child;
    let signalled;
    let grace;
    let stopGoverning;
    let finish = (_code) => { };
    const handlers = FORWARDED.map((sig) => {
        const forward = () => {
            if (child === undefined) {
                unhook();
                d.signals.kill(d.signals.pid, sig);
                return;
            }
            signalled ??= constants.signals[sig];
            signalChild(sig);
            grace ??= setTimeout(() => {
                signalChild("SIGKILL");
                finish(128 + signalled);
            }, GRACE_MS);
        };
        d.signals.on(sig, forward);
        return [sig, forward];
    });
    const unhook = () => handlers.forEach(([sig, forward]) => d.signals.off(sig, forward));
    // A hook slot the session already holds is borrowed through `inheritedHolderId`, never waited for a second time.
    const hookSlot = opts.inheritedHolderId || ownHolder ? undefined : ancestorHookSlot(opts, d);
    const weight = weightFor(command, d.cwd, d.env, d.err);
    const got = await d.acquire(hookSlot ? { ...opts, inheritedHolderId: hookSlot } : opts, { command, label: args.label, cwd: d.cwd, gated: args.gated, suspendable, ...(weight !== undefined && { weight }) }, {
        maxWaitMs,
        onWait: throttledProgress((s) => d.err(`lease: waiting ${seconds(s.waitedMs)}s for a slot (pressure=${s.level}, ${s.live.length}/${s.capacity} live)`), { skipFirst: true }),
    });
    if (!("leased" in got)) {
        unhook();
        d.err(formatRefusal(got, d.leaseStatus(opts)));
        return refusalExitCode(got);
    }
    if (hookSlot && got.leased && got.id === hookSlot)
        d.err(`lease: running inside this session's hook slot (${hookSlot})`);
    else if (got.leased)
        d.err(formatAdmitted(got.admission));
    return new Promise((resolve) => {
        let settled = false;
        finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(grace);
            stopGoverning?.();
            unhook();
            got.release({ exitCode: code });
            resolve(code);
        };
        const cannotRun = (e) => {
            d.err(`lease: cannot run ${file}: ${e.message}`);
            finish(e.code === "ENOENT" || file === "" ? 127 : 126);
        };
        try {
            // Same env merge as `runShellAsync`: `childEnv()` is only the holder-id delta.
            child = d.spawn(file, fileArgs, { env: { ...d.env, ...got.childEnv() }, ...(args.background && { detached: true }) });
        }
        catch (e) {
            // Node throws, rather than emitting 'error', for an empty program name and most errnos (ENOEXEC, ENOTDIR, ELOOP).
            return cannotRun(e);
        }
        child.once("error", cannotRun);
        child.once("close", (code, signal) => {
            const exit = signalled !== undefined ? 128 + signalled : (code ?? 128 + (constants.signals[signal] ?? 0));
            if (args.shell !== undefined && exit === 127) {
                d.err("lease: command not found inside the wrapper; shell functions and aliases are not available under --shell");
            }
            finish(exit);
        });
        if (child.pid === undefined)
            return;
        try {
            if (args.background)
                got.setChildPid(child.pid, child.pid);
            else
                got.setChildPid(child.pid);
        }
        catch (e) {
            child.kill("SIGKILL");
            d.err(`lease: could not record the child PID: ${e.message}`);
            finish(1);
            return;
        }
        if (suspendable && args.background && d.governor) {
            // The group is the child's own (pid = pgid). The leader's command is read once, outside the lease's mutex, after the 20 s a holder must run before it can be suspended.
            const pgid = child.pid;
            const now = opts.now ?? Date.now;
            const startedAt = now();
            let leader;
            let suspended = false;
            const unGovern = d.governor.every(() => {
                // A forwarded signal means the command is stopping: a SIGSTOP now would hold its cleanup until the grace SIGKILL.
                if (settled || signalled !== undefined)
                    return unGovern();
                if (now() - startedAt < SUSPEND_MIN_RUN_MS)
                    return;
                try {
                    leader ??= d.governor.processCommand(pgid);
                    if (!suspendNewest(opts, got, pgid, leader, (g) => signalGroup(g, "SIGSTOP", d.signals.kill)))
                        return;
                    suspended = true;
                    d.err("lease: paused on purpose (SIGSTOP) while the machine is overloaded; do not kill or re-run it");
                }
                catch (e) {
                    d.err(`lease: suspend check failed: ${e.message}`);
                }
            }, GOVERN_MS);
            // A group that was suspended and is now going away takes the lease's record with it, never one another writer put there since; the holder file, and with it the mark, goes with the release.
            stopGoverning = () => {
                unGovern();
                try {
                    if (suspended && readSuspensions(opts.dir).some((r) => r.pgid === pgid && r.by === "lease"))
                        removeSuspension(opts.dir, pgid);
                }
                catch (e) {
                    d.err(`lease: could not remove the suspension record for group ${pgid}: ${e.message}`);
                }
            };
        }
    });
}
// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------
/**
 * The deps `main` runs with: every lease, sink, policy and sampler diagnostic goes through `err`.
 * `base.env` replaces `process.env` everywhere the CLI reads the environment (the lease options, `CO_LEASE_MAX_WAIT` and the child's env);
 * `base.level` replaces the sampler, so none is built. `main` passes neither; tests pass both to stay hermetic.
 */
export function cliLeaseDeps(err, base = {}) {
    const { env = process.env, level } = base;
    return {
        leaseOptions: () => defaultLeaseOptions(env, { warn: err, level }),
        acquire: acquireLease,
        leaseStatus,
        unowned: (opts, sessionPids, heavyChildPids) => sampleUnowned({ dir: opts.dir, now: opts.now }, sessionPids, heavyChildPids),
        ancestors: () => psAncestors(process.ppid, ANCESTOR_DEPTH),
        governor: { every: (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return () => clearInterval(t); }, processCommand: (pgid) => psField(pgid, "command") },
        spawn: (file, fileArgs, opts) => spawn(file, fileArgs, { stdio: "inherit", env: opts.env, detached: opts.detached }),
        env,
        cwd: process.cwd(),
        out: (text) => process.stdout.write(text),
        err,
        signals: process,
    };
}
//# sourceMappingURL=lease-run.js.map