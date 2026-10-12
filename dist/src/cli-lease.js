#!/usr/bin/env node
/**
 * Runs a command under the machine-wide heavy-command lease, or reports who
 * holds it:
 *
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] -- <cmd> [args...]
 *   claude-orchestrator-lease [--max-wait <sec>] [--label <text>] --shell '<command line>'
 *   claude-orchestrator-lease status
 *
 * The slot is held for exactly as long as the command lives, and the command's
 * exit code is passed through. Exit 75 means no slot within the wait cap
 * (rerun); exit 78 means the lease is misconfigured (a relative `CO_LEASE_DIR`).
 *
 * Pure helpers (`parseLeaseArgs`, `runLeased`, `runStatus`) take every external
 * interaction through `LeaseCliDeps`; the file's bottom wires real I/O.
 */
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import { acquireLease, defaultLeaseOptions, leaseStatus } from "./lease.js";
const DEFAULT_MAX_WAIT_SEC = 100;
const GRACE_MS = 10_000;
const PROGRESS_MS = 60_000;
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
const EX_USAGE = 64;
const EX_TEMPFAIL = 75;
const EX_CONFIG = 78;
const seconds = (ms) => Math.round(ms / 1000);
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
/** Prints the holders as JSON; returns the exit code. */
export function runStatus(d) {
    const opts = optionsOrReport(d);
    if (!opts)
        return EX_CONFIG;
    const { level, capacity, live } = d.leaseStatus(opts);
    const holders = live.map((h) => ({ pid: h.pid, command: h.command, ageSec: h.ageSec, ...(h.override && { override: true }) }));
    d.out(`${JSON.stringify({ level, capacity, live: holders }, null, 2)}\n`);
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
    const [file, fileArgs] = args.shell !== undefined ? ["/bin/sh", ["-c", args.shell]] : [args.argv[0], args.argv.slice(1)];
    // Installed before acquiring: a signal's default action would otherwise kill the wrapper between the holder file's
    // write and the spawn, leaving a slot that no child holds. A handler can only run while waiting (nothing is held, so
    // the signal is re-raised to kill the wrapper as before) or once the child exists, never in between.
    let child;
    let signalled;
    let grace;
    let finish = (_code) => { };
    const handlers = FORWARDED.map((sig) => {
        const forward = () => {
            if (child === undefined) {
                unhook();
                d.signals.kill(d.signals.pid, sig);
                return;
            }
            signalled ??= constants.signals[sig];
            child.kill(sig);
            grace ??= setTimeout(() => {
                child.kill("SIGKILL");
                finish(128 + signalled);
            }, GRACE_MS);
        };
        d.signals.on(sig, forward);
        return [sig, forward];
    });
    const unhook = () => handlers.forEach(([sig, forward]) => d.signals.off(sig, forward));
    let lastProgress = d.now();
    const start = lastProgress;
    const got = await d.acquire(opts, { command: args.shell ?? args.argv.join(" "), label: args.label, cwd: d.cwd }, {
        maxWaitMs,
        onWait: (s) => {
            if (d.now() - lastProgress < PROGRESS_MS)
                return;
            lastProgress = d.now();
            d.err(`lease: waiting ${seconds(lastProgress - start)}s for a slot (pressure=${s.level}, ${s.live.length}/${s.capacity} live)`);
        },
    });
    if (!("leased" in got)) {
        unhook();
        const s = d.leaseStatus(opts);
        const holders = s.live.map((h) => `${h.pid} ${h.command}`).join(", ") || "none";
        d.err(`lease: no slot after ${seconds(got.waitedMs)}s (pressure=${got.level}, capacity ${s.capacity}, ${s.live.length} live: ${holders}); rerun the command — this is not a test failure`);
        return EX_TEMPFAIL;
    }
    if (got.leased) {
        const a = got.admission;
        d.err(`lease: admitted after ${seconds(a.waitedMs)}s (pressure=${a.level}, ${a.live}/${a.capacity} live)`);
    }
    return new Promise((resolve) => {
        let settled = false;
        finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(grace);
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
            child = d.spawn(file, fileArgs, { env: { ...d.env, ...got.childEnv() } });
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
            got.setChildPid(child.pid);
        }
        catch (e) {
            child.kill("SIGKILL");
            d.err(`lease: could not record the child PID: ${e.message}`);
            finish(1);
        }
    });
}
// ---------------------------------------------------------------------------
// CLI entry point — only runs when invoked directly.
// ---------------------------------------------------------------------------
/** The deps `main` runs with: every lease, sink, policy and sampler diagnostic goes through `err`. */
export function cliLeaseDeps(err, base = {}) {
    const { env = process.env, level } = base;
    return {
        leaseOptions: () => defaultLeaseOptions(env, { warn: err, level }),
        acquire: acquireLease,
        leaseStatus,
        spawn: (file, fileArgs, opts) => spawn(file, fileArgs, { stdio: "inherit", env: opts.env }),
        env,
        cwd: process.cwd(),
        out: (text) => process.stdout.write(text),
        err,
        now: Date.now,
        signals: process,
    };
}
async function main(argv) {
    let args;
    try {
        args = parseLeaseArgs(argv);
    }
    catch (err) {
        process.stderr.write(`lease: ${err.message}\nusage: claude-orchestrator-lease [--max-wait <sec>] [--label <text>] (-- <cmd> [args...] | --shell '<command line>') | status\n`);
        return EX_USAGE;
    }
    const deps = cliLeaseDeps((line) => {
        process.stderr.write(`${line}\n`);
    });
    return args.kind === "status" ? runStatus(deps) : runLeased(args, deps);
}
// A bin is run through a symlink (`node_modules/.bin/...`), so compare real paths.
const entryPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entryPath === realpathSync(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`lease: ${err.message}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli-lease.js.map