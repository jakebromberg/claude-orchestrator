#!/usr/bin/env node
/**
 * The front end for heavy-queue's syntax, backed by the machine-wide lease (heavy-queue's second line folded into the first):
 *
 *   heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] -- <cmd> [args...]
 *   heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] --shell '<command line>'
 *   heavy-queue status
 *   heavy-queue watch [--interval <sec>]
 *
 * Installed as `claude-orchestrator-heavy-queue`, and behind a two-line `sh` shim at heavy-queue's old path (README, "Heavy-command lease").
 * A run waits with no cap (no `--max-wait`, `CO_LEASE_MAX_WAIT` ignored, never exit 75), in its own gated, background, suspendable
 * holder with no ancestor borrow, and returns the command's exit code (`--priority high`: first in line, no `taskpolicy -b`, never suspendable, every limit kept); a usage error exits 2, disk full 74, a bad lease directory 78.
 * `status` is the lease's own (`runStatus`); `watch` redraws the same view as tables every interval (2 s by default) until Ctrl-C (`heavy-queue-watch.ts`). The run function lives in `lease-run.ts`; this file never imports `cli-lease.ts`, which runs a startup check at load.
 */
import { cliLeaseDeps, runLeased, runStatus, statusView } from "./lease-run.js";
import { runWatch } from "./heavy-queue-watch.js";
import { isEntryPoint } from "./entry-point.js";
const EX_USAGE = 2;
const USAGE = `usage: heavy-queue run --label "<session>: <what>" [--priority normal|high] [--no-suspend] (-- <cmd> [args...] | --shell '<command line>')
       heavy-queue status
       heavy-queue watch [--interval <sec>]`;
const DEFAULT_WATCH_INTERVAL_SEC = 2;
/**
 * Parses heavy-queue's arguments (`run [--label L] [--priority normal|high] [--no-suspend] (--shell C | -- argv...)`, `status`, `watch [--interval S]`); `undefined` is a usage error.
 * The options come in any order before the command, each at most once. `--priority normal` parses to the same result as no `--priority`.
 */
export function parseHeavyQueueArgs(argv) {
    if (argv[0] === "status")
        return { kind: "status" };
    if (argv[0] === "watch") {
        if (argv.length === 1)
            return { kind: "watch", intervalSec: DEFAULT_WATCH_INTERVAL_SEC };
        const sec = Number(argv[2]);
        return argv.length === 3 && argv[1] === "--interval" && argv[2].trim() !== "" && Number.isFinite(sec) && sec > 0 ? { kind: "watch", intervalSec: sec } : undefined;
    }
    if (argv[0] !== "run")
        return undefined;
    let rest = argv.slice(1);
    let label;
    let priority;
    let noSuspend = false;
    for (;;) {
        if (rest[0] === "--label" && rest.length >= 2 && label === undefined)
            [label, ...rest] = rest.slice(1);
        else if (rest[0] === "--priority" && rest.length >= 2 && priority === undefined)
            [priority, ...rest] = rest.slice(1);
        else if (rest[0] === "--no-suspend" && !noSuspend)
            [noSuspend, rest] = [true, rest.slice(1)];
        else
            break;
    }
    if (priority !== undefined && priority !== "normal" && priority !== "high")
        return undefined;
    const high = priority === "high";
    const command = rest[0] === "--shell" && rest.length === 2 ? { shell: rest[1] } : rest[0] === "--" && rest.length >= 2 ? { argv: rest.slice(1) } : undefined;
    return command && { kind: "run", label: label ?? "unlabelled", ...command, ...(noSuspend && { noSuspend }), ...(high && { priority: "high" }), gated: true, background: true, suspendable: true, uncapped: true };
}
/** `watch`'s process side: the lease read through `d`, the terminal and signals through `process`. */
export function processWatchDeps(d) {
    return {
        status: () => statusView(d, d.leaseOptions()),
        now: () => new Date(),
        every: (fn, ms) => {
            const t = setInterval(fn, ms);
            return () => clearInterval(t);
        },
        write: (t) => void process.stdout.write(t),
        isTTY: process.stdout.isTTY === true,
        columns: () => process.stdout.columns || 120,
        signals: process,
    };
}
export async function runHeavyQueue(argv, d, watchDeps = processWatchDeps) {
    const args = parseHeavyQueueArgs(argv);
    if (!args) {
        d.err(USAGE);
        return EX_USAGE;
    }
    if (args.kind === "watch")
        return runWatch(args, watchDeps(d));
    return args.kind === "status" ? runStatus(d) : runLeased(args, d);
}
if (isEntryPoint(import.meta.url, import.meta.main)) {
    runHeavyQueue(process.argv.slice(2), cliLeaseDeps((line) => void process.stderr.write(`${line}\n`))).then((code) => {
        process.exitCode = code;
    }, (err) => {
        process.stderr.write(`heavy-queue: ${err.message}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli-heavy-queue.js.map