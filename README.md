# @funlandresearch/claude-orchestrator

TypeScript engine for launching parallel headless Claude sessions against
GitHub issues. Each session runs in an isolated git worktree, with wave-based
scheduling driven by issue dependencies.

## Install

```bash
npm install @funlandresearch/claude-orchestrator

# Or install directly from GitHub:
npm install github:jakebromberg/claude-orchestrator
```

## Authentication & billing

> **Changed in 0.11.0.** Sessions previously inherited whatever credentials were in your environment. If your setup relies on an ambient `ANTHROPIC_API_KEY`, see [Opting in to API billing](#opting-in-to-api-billing) before upgrading.

Sessions run on the **Claude Code login** — the credential from `claude` / `/login`, or a token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) for CI — so orchestrated work counts against your Claude subscription rather than Anthropic API credits. The orchestrator drives the `claude` CLI; it never calls the Anthropic API directly.

Because the CLI resolves credentials from the environment *before* falling back to that login, an `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` exported in your shell would otherwise silently reroute every session onto pay-per-token API billing. Those two variables are stripped from spawned sessions. `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and other routing/config variables pass through untouched.

Each run prints the mode it's using, naming any credential it dropped:

```
ℹ Auth: Claude Code login (sessions count against your Claude subscription)
ℹ Auth: Claude Code login — ANTHROPIC_API_KEY ignored (set CLAUDE_ORCHESTRATOR_USE_API_KEY=1 to bill API credits instead)
```

### What the scrub does and doesn't cover

- It applies to the session **and everything the session runs** — a command the agent executes through its Bash tool sees the scrubbed environment too.
- `postSessionCheck` is the deliberate exception: it runs *your* commands (tests, lint, typecheck), which may legitimately need an API key, so it keeps the full environment. Commands run asynchronously under `/bin/sh -c` (only the last 64 KiB of output is kept, and a non-zero exit fails the check with that tail), so a slow check does not freeze the engine; an injected `runCommand` may return a string or a Promise. If your test suite is credential-dependent, note that the agent running it in-session and the orchestrator running it afterwards will see different environments. Sessions themselves never see a lease holder: `CO_LEASE_HOLDER` is stripped from their environment too.

  When the engine has a machine-wide lease (a run mode; see [Heavy-command lease](#heavy-command-lease)), each derived check holds **one lease slot** for its whole command loop, labelled `post-check <ref>`. Its commands get the holder id in their child env and report their PID, so the holder stays live while a suite runs. At `critical` memory pressure the check waits, with no time cap and a once-a-minute `waiting for a lease slot` line, for as long as a lease holder or one of the engine's own sessions could still relieve the pressure; once neither is left it returns `stopped: "memory-critical"` without running its commands (the sequential-file collision scan, which only reads git, still runs) and the issue is failed, never retried. Without a lease, none of this happens and no lease I/O is done.
- `ANTHROPIC_CUSTOM_HEADERS` is not scrubbed — it also carries ordinary headers a proxy may require. If you use it to pass a credential, opt in explicitly so the billing mode is accurate.

### Opting in to API billing

You need this if you authenticate with an API key rather than a subscription, or if you route Claude Code through an **LLM gateway** (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) — the gateway token is a credential, so it is scrubbed like any other, and subscription auth won't work against your gateway.

```bash
export CLAUDE_ORCHESTRATOR_USE_API_KEY=1
```

Only `1`, `true`, `yes`, and `on` enable it; anything else — including an unrecognised value or a typo — leaves sessions on the Claude Code login, so a mistake can't quietly start spending.

Programmatic consumers can pass the same choice to the session spawner: `createRealProcessRunner({ useApiKey: true })`. Note that this covers sessions only — the `--decompose` and merge-conflict paths read the environment variable, so set it if you use them.

### Verifying

The CLI records which credential a session used in the `init` event of its log:

```bash
grep -o '"apiKeySource":"[^"]*"' <configDir>/logs/issue-*.log
```

Anything other than `"ANTHROPIC_API_KEY"` (in practice `"none"`) means the session was not billed to API credits.

Amazon Bedrock and Google Vertex backends are not supported: their `CLAUDE_CODE_USE_*` selectors are stripped along with the other `CLAUDE*` variables.

## Memory pressure

`src/memory-pressure.ts` reads the macOS memory-pressure level (`sysctl kern.memorystatus_vm_pressure_level`) and owns the one threshold table later consumers share. The engine's session launches and retries follow it (below), and the heavy-command lease sizes its slots from the headroom step derived from it (see Headroom step). Environment variables:

- `CO_LEASE_SLOTS` — heavy-command slot ceiling at `normal` pressure (positive integer, default `4`). An invalid value keeps the default and is reported once on stderr.
- `CO_PRESSURE_OVERRIDE` — set to exactly `critical-as-warning` to make this process (and what it starts) read `critical` as `warning`. Any other value is ignored with a warning.
- `CO_LEASE_DIR` — lease directory, which must be absolute (default `${XDG_STATE_HOME:-$HOME/.local/state}/claude-orchestrator/lease`); the sampler persists its last raw reading to `level.json` there, only if the directory already exists and is one the lease accepts (a real directory this user owns, not a symlink). A relative `XDG_STATE_HOME` is ignored; without an absolute `HOME`, the account's home directory from the user database is used, and with neither the sampler throws rather than resolve a path against the working directory.

### Headroom step

`readMemorySignals()` (`src/memory-pressure.ts`) reads the pressure level and the free percentage (`kern.memorystatus_level`) in one guarded `sysctl` call, and the swap values (`vm.compressor.swapper.used_bytes`, `allocated_bytes`, `swapins_total`) in a separate optional one. A failed guarded read returns `null`, so the caller keeps the last-good-else-`critical` rule; a failed optional read only leaves the swap fields absent, so a renamed swap oid can never turn into `critical`. Off darwin it reports `unknown`. `headroomStep(signals, previous, nowMs, table)` (`src/headroom.ts`) is a pure function from those signals to a step from 0 to 4 plus `risingSince`: `critical` is 0 at once, `normal` and `unknown` are 4, and `warning` takes the best band of `table.warning` that the free percentage meets. A lower step applies at once; a higher one rises one step per call after `table.riseHoldMs` with a higher target holding (`previous` is the last returned `{ step, risingSince }`). `DEFAULT_STEP_TABLE` is the owner's Q1 table: `normal` 4; `warning` 3 at 40% free or more, 2 at 30 to 39%, 1 under 30%; `critical` 0; a rise waits 60 s per step. A band's step is clamped to 0..4, and a `previous` whose step is not an integer from 0 to 4 (or whose `risingSince` is not finite) is treated as absent. Swap values are carried but never stepped on. `headroomCapacity(step, policy)` gives the heavy slots: step 4 is `CO_LEASE_SLOTS`, a lower step is at most that many, step 0 is none. `heavyCapacity`, `sessionCapacity` and `readMemoryPressure` are unchanged.

**Sharing the step.** `<lease dir>/headroom.json` holds `{ at, signals, step, risingSince }`: the one machine step, computed from the raw signals with the rise hold and before any per-process override. A stored or in-process step whose `at` is as old as a full climb (`riseHoldMs` × 4, 4 minutes with the default table) is ignored, and the next reading starts at its target: no process sampled in that gap, so nothing was waiting, and a falling step never suspends. `defaultHeadroomSampler()` (`src/headroom-sampler.ts`) reads it while `at` is under 10 s old (an `at` from the future is not fresh), and otherwise samples `sysctl`, steps from the stored `step` and `risingSince` (a malformed or out-of-range record is treated as absent), and rewrites it, together with `level.json` in its existing format. It writes through `writeLeaseRecord`, with no lock (the last writer wins, which can delay a rise by one sample), and only into a lease directory that is a real directory this user owns; it never creates the directory, so `leaseStatus` and read-only callers create nothing. `fresh()` bypasses the file and the cache and rewrites it; the stop rule confirms through it. A failed guarded read uses the last good reading under 60 s old, else `critical`, and is not shared. `CO_PRESSURE_OVERRIDE=critical-as-warning` maps `critical` to `warning` and step 0 to 1 in its own process only; the file always holds the machine step.

`LeaseOptions.headroom` takes the sampler. When it is set, heavy capacity comes from the step; `defaultLeaseOptions` builds one sampler and derives `level` (and `level.fresh`) as a view over it, so the engine's pressure sampler and the lease read the same reading. When it is absent (a caller that passes `overrides.level` to `defaultLeaseOptions`, or a test), the lease sizes capacity from the level alone (`warning` → 1); `defaultLeaseOptions` with no `level` override always sets it, so the Q1 table applies to every production caller. `leaseStatus` returns `step` and `signals` (`null` after a failed guarded read, or with no `headroom`) beside `level`, `capacity` and `live`, and the `acquire` event records `step`. Heavy slots at `warning` are therefore 3, 2 or 1 by free memory; an engine's own launch capacity still reads the level (K at `normal`, 1 at `warning`).

### Engine registry

In the modes that launch sessions, each engine records itself in `engines/<pid>.json` under the lease directory (`CO_LEASE_DIR`), as `{ pid, pgid, runId, logDir, stallTimeout, startedAt }`, where `stallTimeout` is the largest effective stall timeout (seconds) across the run's issues, or `0` when any issue disables stall detection (`0` means a watchdog applies no silence check). The file is written at start, rewritten every 30 s (its mtime separates a live engine from a dead one; the timer does not keep the process alive) and removed at exit, on a failed run and on SIGINT/SIGTERM. A SIGKILLed engine leaves its file behind. `engines/` follows the same directory rule as `holders/` and `waiting/` (exported as `ensureOwnSubdir`): created with mode 0700, and so is the lease directory when it does not exist yet; an existing one this user owns is tightened to 0700; a symlink, a non-directory or another user's `engines/` is refused and nothing is written. Write, remove and refused-directory failures never fail a run. The `Deps.engineRegistry` seam takes a fake in tests; older builds ignore `engines/`.

### Adaptive session launches

With a pressure sampler in `Deps` (the CLI wires `defaultLeaseOptions(process.env, { warn: consoleLogger.warn }).level`, which logs through the engine Logger with a `memory-pressure:` tag, in the modes that launch sessions; `--status`, `--plan` and the other read-only modes never read pressure), the engine re-reads the level every 10 s and sizes the pool to `min(--parallel, launch capacity)`. Launch capacity bounds pipelines, not only live `claude` processes, because a pipeline keeps its slot through its post-session check and retries. It is up to `--parallel` pipelines at `normal` (once `normal` has held for 60 s after a `warning` or `critical`) and at `unknown`, one at a time at `warning`, and none at `critical`. Running sessions are never touched. Without a sampler the engine behaves as it always has.

At `critical` nothing new starts, neither a launch nor a retry (the 0-byte retry and the check-failure retry). Waiting never relieves pressure, so no timer turns a wait into a start: once no pipeline is active and a fresh reading still says `critical`, the wave ends. Each unstarted issue stays `pending`; a retry refused at `critical` marks its issue `failed`. Every memory-pressure stop is recorded on the issue's metadata and on its report row as `failureReason: "memory-critical"` plus `stopStage` (`launch`, `retry` or `post-check`), so a stopped issue is not mistaken for a model failure or a held cutover gate. The marker is cleared when the issue later launches, retries or runs its check, and whenever a later dispatch takes the issue up again (an issue that already succeeded keeps its metadata). The way past the stop rule is `CO_PRESSURE_OVERRIDE=critical-as-warning`.

A session can also stop itself: when its final `result` message contains the exact line `orchestrator-stop: lease-wait` (an agent giving up after repeated lease denials), the engine skips the post-session check and any retry and marks the issue `failed` with `failureReason: "lease-wait"` and `stopStage: "session"`, even if the session left commits and the check would pass. Any other `orchestrator-stop: <reason>` is ignored with a warning.

`--no-adaptive` turns off `warning` adaptation and the 60 s hysteresis only. It never bypasses the stop rule.

### Heavy-command lease

`src/lease.ts` is a machine-wide, file-based lease for heavy commands (`acquireLease`, `tryAcquireLease`, `leaseStatus`, `defaultLeaseOptions`); the `claude-orchestrator-lease` bin (below) is its command-line entry point. A request is admitted while the number of live holders is below the heavy capacity: `headroomCapacity(step, policy)` from the machine headroom step (at `warning`, 3 slots at 40% free or more, 2 at 30 to 39%, 1 under 30%, each capped by `CO_LEASE_SLOTS`; 0 at `critical`), or `heavyCapacity(level, policy)` when a caller injects only `level`; otherwise it polls every 3 s ± 1 s and never spins. Waiters are admitted in the order they arrived. A waiter (`acquireLease`) that is refused writes a ticket, `<lease dir>/waiting/<id>.json` (mode 0600; `{ seq, id, pid, label, gated, capacity, ready }`), and refreshes its mtime on every poll. `seq` is one more than the highest `seq` among the tickets that exist (stale ones included), assigned under the mutex, and `pid` is the waiting process. `capacity` is the heavy capacity its owner last computed and `ready` whether its gates passed at that poll; a ticket counts as ahead of another only while its owner could be admitted (`capacity` above the live holders and `ready` not `false`), so an owner at `critical` (capacity 0), or one with a lower `CO_LEASE_SLOTS`, does not hold up a waiter that can be admitted, such as a process under `CO_PRESSURE_OVERRIDE`. A ticket from a build that predates the two fields counts. A waiter is admitted when the number of such tickets ahead of its own is less than the free slots (`capacity` minus live holders), so two free slots admit the two oldest in the same cycle. The ticket is removed after the holder is created and its removal is guarded, so a failure there never discards the admission.

**Gated tickets.** A request with `HolderMeta.gated` set (only the heavy-queue front end will set it; hook calls, engine post-checks and direct CLI calls are never gated, and a gated ticket that fails its gates does not hold up an ungated one; among gated waiters the line stays FIFO, since the gates are machine-wide: a gated waiter is not admitted while any older gated ticket that could be admitted waits, whatever its last poll said and however many slots are free, and such a waiter records itself as not ready so ungated waiters pass it) is admitted only when heavy-queue's gates pass, checked under the mutex: CPU busy is under 0.75, no live holder is marked `suspended`, and at least 20 s have passed since the last gated admission. The thresholds are constants. CPU busy comes from `LeaseOptions.cpuTimes` (`osCpuTicks`, the `os.cpus()` tick counters, so no process is spawned) and `<lease dir>/cpu.json` (`{ at, ticks, busy }`): a stored reading under 2 s old is gated on as stored, one 2 to 10 s old is the base of a new delta (busy is 1 minus the idle share of the ticks since) and is rewritten, and an older, future-dated or missing one is replaced and fails that poll, so the next poll, about 3 s later, gates on a real delta. A failed or empty tick read, or no `cpuTimes`, leaves the CPU unknown and passing. Every gated poll reads the CPU, whether or not a slot is free. The last gated admission is the mtime of `<lease dir>/lastAdmit`, dated on `LeaseOptions.now`; a mark dated in the future reads as elapsed. No-wedge rule: when no holder is live, the oldest gated ticket is admitted whatever CPU, suspension and spacing say, except at step 0, where capacity is 0 and nothing is admitted. Both records are written with `writeFileAtomic`. Admission is still capped by the step's capacity and the tickets ahead. A ticket is eligible while its `pid` is alive and its mtime is within 15 s of the reader's clock (the symmetric rule `isWithinWindow`). A ticket whose process was stopped stops refreshing and is passed over, without being reaped, so it cannot block the line; it keeps its `seq` and is eligible again once the waiter resumes. A ticket whose `pid` is dead, or that cannot be parsed, is reaped by any waiter. A waiter removes its own ticket when it is admitted, when it gives up (`maxWaitMs`, a stop rule, an I/O error) and when `acquireLease` returns or throws. `tryAcquireLease` writes no ticket and is admitted only when a slot is free and no eligible ticket waits. A nested acquire that names a live holder (`inheritedHolderId`, or a detached id that is already live) is admitted at once and never queues. The hook's 450 s wait and two-denial give-up are unchanged, and a rerun after a denial joins at the back. Builds that predate tickets ignore `waiting/`, so one of them can still take a free slot ahead of the line. A holder is live while its heartbeat is fresh, or its recorded child PID is alive and its start is within 2 h of now (a start further in the future is past the bound too). The holder refreshes its holder file's mtime every 30 s from an unref'd timer that release clears, and the heartbeat is fresh while that mtime is within 90 s of now, using the mutex's rule: a future-dated mtime counts as fresh up to 90 s ahead and stale beyond. The heartbeat needs the holder's event loop: a caller that blocks it for 90 s (`execSync`, `spawnSync`) without recording its child's PID through `setChildPid` is reaped while its command still runs, and stays out of the count until it releases, since neither the heartbeat nor `setChildPid` recreates a reaped holder's file. `LeaseOptions.now` must be wall-clock epoch milliseconds, because heartbeats are compared with file mtimes. The wrapper PID is not consulted, so a recycled one cannot pin a slot; a stale heartbeat with no live child is reaped with reason `stale-heartbeat`. A detached holder (`HolderMeta.detached`, used by hook mode) has no wrapper to beat: it records its caller's `id` and `expiresAt`, the PID it records is the session's, and the heartbeat rule never applies to it. It is live while that PID is alive and `expiresAt` is ahead (reaped as `dead-session` when the PID is dead, and as `expired` once `now() >= expiresAt` or when `expiresAt` is more than 750 s ahead: the 660 s cap a writer may set (`DETACHED_TTL_MAX_MS` in `src/lease.ts`), plus 90 s so a small backward clock step never reaps a holder written within the cap). A detached id must match `[A-Za-z0-9_-]{1,160}`, its session PID must be a positive integer below 2^31 and its `expiresAt` finite, or acquiring throws a `TypeError`. Acquiring an id whose holder is already live is admitted at once, with no second holder file or count, so two hook installs handling one call share one slot. `releaseHolder(opts, id)` removes one by id from any process and emits its `release` event; it leaves a non-detached holder and a corrupt file alone, and does not read a lease or holders directory that breaks the directory rule. The lease fails open (an unleased handle and one warning) on a directory I/O error, including a holder file it cannot read, or a mutex busy for 30 s, except at `critical`, where that counts as no free slot; `leaseStatus` then reports no live holders rather than throw. Only an unparseable or malformed holder file, including one whose PID or child PID is not a positive integer below 2^31 or whose `expiresAt` is present but not a finite number, is reaped as corrupt. The directory is created with mode 0700 at the first acquire, never by `defaultLeaseOptions()`; an existing lease, holders or waiting directory this user owns is tightened to 0700, and one that is a symlink, not a directory, or another user's is an I/O error (platforms without uids skip the ownership check). A holder records its caller's label verbatim when given; otherwise it records the command up to and including its first `=` or `://`, followed by `…`, so `NAME=value` credentials and `user:token@` URLs are cut off whatever quoting surrounds them (a marker that is itself split by quotes, such as `https:"//"`, is not seen). The lease does no shell parsing. This is paste-safety for `status` output and the event log, not a security boundary. Secrets with neither marker before them (`-p pass`, `-u user:pass`, `Authorization:` headers) are not removed; pass a label for such commands. The recorded text is truncated to 200 characters. `onEvent` and `warn` run only after the lease releases its mutex. A callback that throws never changes what the lease does, and a throwing `onEvent` is reported once through `warn`.

The lease directory has one rule, in `src/lease-dir.ts`: a real directory (not a symlink) that this user owns, at mode 0700. Every lease record goes through it: `ensureOwnSubdir` creates `holders/`, `waiting/` and `engines/` under it, and `writeLeaseRecord` writes a root-level record (`level.json`, and later ones) only while the directory passes the rule, never creating it and returning `false` when it refuses; the event sink applies the same `isOwnDir` check. Every JSON record in the lease directory (tickets, holders, `engines/<pid>.json`, `level.json`) is written with `writeFileAtomic` (`src/atomic-write.ts`): a temp file unique per process and call, mode 0600, an optional mtime applied before the rename, and the temp file removed when the write fails. A new record uses it too, so an unlocked writer never shares a temp name with another process. `defaultLeaseOptions(env, { level, warn })` takes two optional overrides: `level` is the sampler to use instead of building one, and `warn` is the one writer for the lease's diagnostics, the sink's, the `CO_LEASE_SLOTS` policy's and the sampler it builds (without it each writes to stderr, and the lease and the sink share one default that prints the message as is, each starting `lease:`). The CLI passes its own `err`, so every line it prints is identifiable: the policy's and the sampler's lines now start `memory-pressure:` (for example `memory-pressure: ignoring invalid CO_LEASE_SLOTS="many"; keeping 4`) and the lease's and the sink's start `lease:`. The injected writer is wrapped once so a throwing one never changes what the lease, policy, sampler or sink does; such a writer is silenced (the lines it throws on are dropped and nothing reports the throw), so pass a bound function, and the `warn` on the returned options is that wrapper, not your function. `defaultLeaseOptions()` wires `onEvent` to `leaseEventSink` (`src/lease-events.ts`), which appends one JSON line per event to `events.jsonl` in the lease directory (`CO_LEASE_DIR`, default `${XDG_STATE_HOME:-$HOME/.local/state}/claude-orchestrator/lease`). It appends only while that directory exists and is one the lease accepts (a real directory this user owns), so read-only modes create nothing and a directory the lease refused gets no write; it appends only to a regular `events.jsonl` (mode 0600), never through a symlink and never waiting on a FIFO. Past 5 MB the file is renamed to a single `events.jsonl.1`, replacing any previous one, and a fresh file starts; when that rename fails, the event is still appended and the sink warns once (a rename that finds the file already rotated by another process is not a failure and is not reported). Two processes that rotate at once can lose one generation of lines. A write failure is swallowed and never fails an acquire or a release. Each line is the lease's event as it is plus `ts` (ISO 8601). Fields by `type`: `acquire` (`id`, `waitedMs`, `level`, `live`, `capacity`, and `override: true` only when `CO_PRESSURE_OVERRIDE=critical-as-warning` actually mapped a `critical` reading to `warning`), `release` (`id`, `heldMs`, `exitCode` when given), `timeout` (`refused` of `max-wait` or `stopped`, `waitedMs`, and `level` for `stopped`), `reap` (`id`, `reason`: `stale-heartbeat`, `orphan-bound`, `corrupt`, `dead-session` or `expired`, plus any reason a later slice adds, written unchanged), and `fail-open` (`reason` of `io-error` or `mutex-busy`, `waitedMs`, and the error's `code` and `message` for `io-error`). A holder reaped while its command still runs later emits its own `release`, so one id can show both a `reap` and a `release`. The same `override` is recorded in the holder file. `PressureSampler.overridden()` reports it: true when the last level the sampler returned was mapped from `critical`.

- `CO_LEASE_DIR` — see above.
- `CO_LEASE_HOLDER` — the holder id of an admitted lease, passed only in the child's env (`handle.childEnv()`), never set in the holder's own `process.env`. A nested acquire in that child (`defaultLeaseOptions()` reads it as `inheritedHolderId`) is admitted at once while the holder is live. The CLI also sets it itself when it borrows its session's hook slot (see the hook-mode CLI rule); an inherited value takes precedence over that lookup.

#### `claude-orchestrator-lease`

Holds a slot for exactly as long as a command lives, for callers that run heavy commands outside the engine (a main session running a repo's CI, or a command wrapped by hand). Invoke it as `node "${CO_HOME:-$HOME/Developer/claude-orchestrator}/dist/src/cli-lease.js"` (also the `claude-orchestrator-lease` bin):

```
claude-orchestrator-lease [--max-wait <sec>] [--label <text>] -- <cmd> [args...]
claude-orchestrator-lease [--max-wait <sec>] [--label <text>] --shell '<command line>'
claude-orchestrator-lease status
```

- The command runs with inherited stdio and the caller's environment plus `CO_LEASE_HOLDER`. `--shell` always runs `/bin/sh -c`, never `$SHELL`, so shell functions and aliases are unavailable (a `--shell` command that exits 127 gets a hint). Once admitted, `lease: admitted after <n>s (pressure=<level>, <live>/<capacity> live)` goes to stderr.
- `--label` is recorded in the holder in place of the command; use it for anything that starts with `NAME=value` words or carries a secret.
- The command's exit code is passed through. A command that cannot be started exits 127 when it is not found and 126 otherwise (for example, a script with no `#!` line), with the slot released. `SIGINT`, `SIGTERM` and `SIGHUP` are forwarded to the child; if it is still alive 10 s later it gets `SIGKILL`, the slot is released, and the wrapper exits 128+n. A signal that arrives while the wrapper is still waiting for a slot kills it, with nothing held. The child's PID is recorded in the holder, so a wrapper killed with `SIGKILL` keeps its slot while the child lives.
- **Exit 75**: no slot within the wait cap (`--max-wait <sec>`, else `CO_LEASE_MAX_WAIT`, else 100 s, under the Bash tool's 120 s timeout). The message lists who holds the slots; rerun the command, this is not a test failure. While waiting, one progress line is printed per minute. `--max-wait 0` does not wait.
- **Exit 78**: the lease is misconfigured (for example a relative `CO_LEASE_DIR`); the command is not run. Usage errors exit 64. If the lease directory is unusable the command runs unleased after one warning.
- `status` prints `{ level, capacity, live: [{ pid, command, ageSec }] }` as JSON (`override: true` on a holder admitted while `CO_PRESSURE_OVERRIDE` actually turned a `critical` reading into `warning`). It never creates the lease directory; in an existing one, reading the pressure level refreshes `level.json`.

#### Suspension records (`claude-orchestrator-lease suspend` / `resume`)

A deliberate stop needs a record a watchdog outside the stopped tree can read, so a recorded stop is told apart from an unexplained one. These are manual commands, for a person or for a session acting on the owner's explicit request; nothing calls them automatically.

```
claude-orchestrator-lease suspend <pgid> --by <who> --reason <why> [--remind <n>m|<n>h] [--record-only]
claude-orchestrator-lease resume <pgid>
```

- `suspend` writes `<lease dir>/suspensions/<pgid>.json` (a `SuspensionRecord`: `{ pgid, by, reason, at, remindAt, leader }`, mode 0600, written and read only through `src/suspensions.ts`; the directory is created at 0700 under the lease's directory rule, so a symlinked or foreign `suspensions/` is refused) and then sends `SIGSTOP` to the group. `remindAt` is `at` plus `--remind` (a positive integer with an `m` or `h` unit, at most `720h`, default `2h`; anything else exits 64). `leader` is the command of the member whose pid is the pgid, or `null` when the leader has exited. `--record-only` writes the record and sends no signal, for a group that is already stopped. If the signal fails the record is removed again.
- `resume` sends `SIGCONT` to the group and then removes the record. With no record it still sends the signal and prints that no record existed; a group that is gone (`ESRCH`) has its record removed.
- Both refuse (exit 1, nothing written, no signal): a pgid that is not a pid, 0 and 1, the caller's own group, the group of any ancestor of the caller (walked through the same scan's `ppid` column; a link missing from the scan, or a chain that does not reach pid 1 within 64 steps, refuses, so a cut-short scan never lets a session stop its own tree), and a group with any member owned by another user. `suspend` also refuses a group with no live members and a group that already has a record.
- Ancestry, group membership, ownership and the leader's command come from one bounded `ps -axo pid=,ppid=,pgid=,uid=,command=` scan; `kill(-pgid, 0)` is never used as a probe. `ps`, the signals and the clock are injected (`src/suspensions.ts`), so the tests signal only `sleep` children they spawned.

#### Watchdog (`claude-orchestrator-watchdog`)

A stopped engine takes its in-tree stall monitor with it, so the report has to come from outside every tree. The watchdog is a separate bin that sends no signal (its dependencies are `ps`, the clock and the file system):

```bash
claude-orchestrator-watchdog check   # scan once; update watchdog.json, watchdog.log and watchdog.brief
claude-orchestrator-watchdog brief   # print watchdog.brief (nothing when all is well)
```

Its state lives in the lease directory (`CO_LEASE_DIR`): `watchdog.json` (first-seen-stopped times and the latest findings) and `watchdog.brief` (one line, empty when all is well; a status line can read it on every refresh) are written atomically; `watchdog.log` is appended (regular files only, symlinks not followed). `check` never creates the lease directory and writes nothing when it is missing, a symlink or another user's. Run it from a scheduler; installing one is a separate step.

- **Scan.** One `ps -axo pid=,ppid=,pgid=,uid=,stat=,etime=,command=` per run through `ps.ts`, with a 60 s timeout. A scan that throws or returns no rows skips the cycle: the previous state stays and the skip is logged.
- **Scope.** A stopped group (every member's `stat` starts with `T`) that contains or descends from a `claude` process, or belongs to a registered engine. A job stopped with Ctrl-Z outside those trees is not reported.
- **Unrecorded stopped group.** Reported 5 minutes after it was first seen stopped (5 to 7 minutes after the stop at a 2-minute interval), unless the group has a valid suspension record (`readSuspensions`: a canonical `<pgid>.json` whose body validates; a partial or invalid record, or one in a symlinked or foreign `suspensions/`, does not count).
- **Engine registry.** A record in `engines/` is fresh while its mtime is within 3 refresh periods (90 s) of the clock. A stale record whose pid has no row in the scan is a dead engine, reported once per `runId`; the record is left in place (it belongs to the engine's directory). A stale record whose pid is alive is a stopped or wedged engine. When its whole group is stopped, the stopped-group rule reports it by its `pgid` (or the scan's `pgid` for its pid when the record holds `null`). Otherwise it is reported as an engine, whatever the group's state: 5 minutes after its last refresh when the engine's own process is stopped (`stat` `T`), and, when it is running, once its record is older than its `stallTimeout` plus 10 minutes (40 minutes at ship-dag's 1800 s default; a healthy engine stops refreshing while a long synchronous command blocks it), never at `stallTimeout` 0, because the engine's sessions share its group and keep it from being stopped throughout. It keeps that report until the stopped-group rule reports the group. A pid counts as the engine's only when its process (by `etime`) started no later than the record's `startedAt`; a later process holds a reused pid, and the engine is reported dead.

The rules are a list (`RULES` in `watchdog.ts`) of functions from the scan to findings, so a new rule needs no change to the reporters.

#### Hook mode (`claude-orchestrator-lease hook`)

Agents run most heavy commands through the Bash tool, where prompt text cannot enforce a machine-wide limit. `hook` is the command for a user-level Claude Code `PreToolUse`/`PostToolUse`/`PostToolUseFailure` hook on `Bash`: it reads the hook's JSON from stdin (`hook_event_name`, `tool_name`, `tool_use_id`, `cwd`, and `tool_input`'s `command`, `timeout` and `run_in_background`; nothing else) and the environment variables `CO_LEASE_HOOK`, `CO_LEASE_SESSION_PID`, `BASH_DEFAULT_TIMEOUT_MS` and the lease's own, and decides whether the command is heavy. It never rewrites the command. Unparseable input, a non-Bash tool, or any error exits 0 silently (hook mode builds its lease options with a silent writer, so a bad `CO_LEASE_SLOTS`, a failed pressure read or an unwritable lease directory prints nothing).

- **What each event does.** All three check `tool_use_id` against `^[A-Za-z0-9_-]{1,128}$` first; an id that fails is malformed input, and the hook does nothing. Holder ids are `hook-<tool_use_id>`.
  - `PreToolUse`, for a heavy command, once the hook has a valid `CO_LEASE_SESSION_PID` and usable lease options (otherwise it does nothing, background calls included; a lease directory that fails only at acquire still denies a background call, while a foreground one fails open): with `tool_input.run_in_background: true` it denies the call (`lease: run heavy commands in the foreground so the lease can track them`). Otherwise it waits up to 450 s for a slot (the printed `PreToolUse` entry has `timeout: 500`, because a hook that times out lets the call through unleased). **Admitted:** it records a detached holder for the Claude Code process and prints the admitted line (`lease: admitted after <n>s (pressure=<level>, <live>/<capacity> live)`, the CLI's own formatter) as `additionalContext`, with no `permissionDecision`, so the normal permission flow runs on the unchanged command. **Not admitted within 450 s:** it denies the call with the CLI's no-slot line (`lease: no slot after <n>s … rerun the command — this is not a test failure`) as the reason. Claude Code prefixes every `PreToolUse` deny reason with `PreToolUse:Bash hook error: `, so the model reads `PreToolUse:Bash hook error: lease: no slot after 450s …` (observed on Claude Code 2.1.288); match `lease: no slot after` as a substring, not anchored at the start, and do not read "error" as a broken hook. A fail-open below `critical` (an unwritable directory, a mutex busy for 30 s) writes no holder and prints nothing, so the call runs unleased; at `critical` it counts as no free slot. Without a valid `CO_LEASE_SESSION_PID` the call also runs unleased.
  - `PostToolUse` and `PostToolUseFailure` remove holder `hook-<tool_use_id>` if it exists and is a detached holder. Idempotent, and silent.
  - The holder's liveness PID is `CO_LEASE_SESSION_PID`, which the printed settings line sets from the hook shell's `$PPID` before its pipe (node's own parent inside a pipeline is a short-lived subshell). The holder expires at admission + the call's Bash timeout (`tool_input.timeout`, else `BASH_DEFAULT_TIMEOUT_MS`, else 120 000 ms, capped at 600 000 ms) + 60 s, so at most 660 s after admission, and is reaped as `dead-session` or `expired` (both appear in `events.jsonl`) when the session PID dies or that time passes.
  - **What the lease cannot see.** It tracks the session, not the command's process. A command auto-backgrounded at its Bash timeout fires its release hook while it keeps running, so its slot frees early (observed on Claude Code 2.1.288). A call this hook admitted but another hook or the classifier then refused fires no release hook, so its slot holds until `expiresAt` (3 minutes at the default timeout, up to 11 at 600 s); a user `PreToolUse` hook that blocks an admitted call does the same (neither case has been tested). An interrupted call fires neither `PostToolUse` nor `PostToolUseFailure` (despite the latter's `is_interrupt` field): its holder stays live, counting toward capacity, until `expiresAt` (3 minutes at the default timeout, up to 11 at 600 s), when it is reaped as `expired` (observed on Claude Code 2.1.288 in headless sessions; Esc in the interactive app is untested). If the session exits first, the dead-session rule above reaps it sooner. A killed session fires no release hook either way, and its holder is reaped as `dead-session` at the next acquire (observed on Claude Code 2.1.288). SIGKILL also orphans the running command: its shell and children are reparented to PID 1 and finish unleased, while SIGTERM kills the command's process group (observed on Claude Code 2.1.288). A slot wait is silent: during the 450 s wait the session writes no stream-json output until the hook decides (observed on Claude Code 2.1.288). The engine's detector is `stallTimeout` (`src/engine.ts`, `StallMonitor` on log growth; per-issue `stallTimeout` overrides the config value, `0` disables it) and has no built-in default. The monitor checks the stdout log every 10 s (`STALL_CHECK_INTERVAL_MS`) and adds 10 s per check that sees no growth, so it kills a session up to about 20 s after `stallTimeout` of silence. A `stallTimeout` must be clearly above about 460 s (the 450 s wait plus hook start-up), or it kills a session that is waiting for a slot. An admitted command can also run silently for up to its Bash timeout, which is 600 s at most unless `BASH_MAX_TIMEOUT_MS` is raised (the lease caps the call timeout it uses for `expiresAt` at 10 minutes, see below, and the command itself is not capped), so pick a value above the longest Bash timeout your sessions use, such as the 1800 ship-dag configs use. Releasing a session's other `hook-*` holders on its next `PreToolUse` would shorten an interrupted call's hold, but parallel Bash calls in one session make that unsafe without more design. `PreToolUse` runs before the permission prompt, so the `expiresAt` clock starts there: a call that waits more than about 60 s for a user's approval can be reaped as `expired` while it still runs, and a call the user denies at the prompt fires no release hook and holds its slot until `expiresAt`. A call timeout above 10 minutes (a raised `BASH_MAX_TIMEOUT_MS` or `BASH_DEFAULT_TIMEOUT_MS`) is capped at 10, so such a call's slot frees before it ends. Every lease client that shares the directory must understand detached holders: a lease build from before hook mode part 2 judges `hook-*` holders by the heartbeat rule and reaps them as `stale-heartbeat` after 90 s, so upgrade the engine and any other clients before installing the hook.
- `CO_LEASE_HOOK=on` is the gate. Anything else, including unset, makes the hook a no-op. Set it on engine invocations, or launch a session as `CO_LEASE_HOOK=on claude`.
- A command is heavy by two rules. The matcher errs toward heavy: a miss runs a heavy command unleased, while a false match costs only a wait.
  1. **The CLI rule.** A command whose text contains `cli-lease.js` or `claude-orchestrator-lease` anywhere is never heavy, so the hook never takes a slot for a command whose text names the CLI, and the CLI never waits behind the hook for its own command. This is a whole-text check, not a parse: a CLI reached indirectly, for example through an `npm test` script that wraps its runner in the CLI, is not seen, so the hook takes a slot for `npm test`. The CLI inside does not wait for a second one: before acquiring (when `CO_LEASE_HOLDER` is unset) it looks for a live hook holder (one with `expiresAt` set) whose session PID is one of its ancestors, found by a bounded `ps -o ppid=` walk from its parent, and borrows that slot through the same live-id rule as `CO_LEASE_HOLDER`: it prints `lease: running inside this session's hook slot (hook-<id>)`, passes `CO_LEASE_HOLDER=hook-<id>` to its command, and emits no `acquire` or `release` event. A holder whose session PID is not an ancestor never admits this way, and a failed ancestor lookup falls back to a normal acquire. **Known gap:** the match is per session, not per Bash call, because the CLI cannot see its own `tool_use_id`. A CLI reached through a call the matcher classed light (`./ci.sh` wrapping the CLI) borrows a slot held by a concurrent heavy call of the same session, and runs uncounted while both run. The walk also reaches past the nearest session, so a Claude Code session launched inside another session's heavy call (an engine worker under an outer `make orchestrate`, say) can borrow the outer session's hook slot. A command that borrowed a slot runs uncounted until it ends, even after that slot is released or expires; the release or expiry only stops new borrows. The trade is that a command which only mentions the CLI (`cat …/cli-lease.js; npm test`, `claude-orchestrator-lease status && npm test`) runs unleased, which is no worse than having no hook.
  2. **The raw split.** Everything else is split into segments at `&&`, `||`, `;`, `|`, a single `&`, newlines, `(`, `)`, backticks, `{` and `}` (a backslash-newline is joined first). Quotes, heredocs and comments are not tracked: a separator inside quotes, a heredoc body or a comment still splits, so the text after it can match (that false match costs only a wait), and an apostrophe in a commit message can never hide a later command. Each segment's leading words are stripped one whitespace token at a time, with leading quote characters ignored: `NAME=value` (a quoted value runs to its closing quote), `nohup`, `exec`, `command`, `if`, `elif`, `while`, `until`, `then`, `do`, `else`, `!`, `env`, `time`, `nice` and `timeout`, and `sh`/`bash`/`zsh`. After `env`, `time`, `nice` and `timeout` the option tokens (starting with `-`) are skipped before the operand: `-u` and `-C` (`env`), `-n` (`nice`) and `-k`/`-s` (`timeout`) take one separate argument, while `--signal=KILL`, `-n10`, `-10` and `-p` take none, and `timeout` then skips its duration (`timeout -k 5 600 npm test`, `nice -10 npm test`, `env -u FOO npm test`). After `sh`/`bash`/`zsh` the option tokens are skipped up to the flag that ends in `c` (`-c`, `-lc`), and a flag ending in `o` takes an argument (`bash -euo pipefail -c '…'`, `bash --login -c '…'`); a shell with no such flag is the command word. A token after the command word that is wholly quoted, with no other quote inside, is tested without its quotes, so `npm "test"` is heavy, while `""` and `"O'Brien"` keep theirs for git's quoted option values. The command word, with its quotes and any leading path (`./`, `.venv/bin/`) removed, and the rest of the segment are then tested against the patterns. So `out=$(npm test 2>&1)`, `bash -c 'npm ci && npm test'` and `if ! npm test; then …` are heavy. A command word that fails is stripped as well, once per segment, when it looks like the tail of a word that a separator split: it is glued to the `)`, `}` or backtick before it, or it holds an odd number of `"` or `'`. This is a heuristic, not a parse. It makes `PYTHONPATH=$(pwd)/src pytest` and `FOO="a;b" npm test` heavy, and it can still make some prose heavy, which costs only a wait. A tail of punctuation only (`): make …`, `), make …`) is prose and is not stripped, and a contraction's apostrophe (`Let's make`, `don't`, `we're`) is not a quote (any other letter-quote-letter is, so `FOO='a;b'c npm test` stays heavy), so Conventional Commits subjects and contractions in heredocs stay light. When a word still fails in a segment that follows `)`, `}` or a backtick, the matcher scans forward once to the first token with an odd quote count and resumes after it, so a value of several words (`NODE_OPTIONS="--require ${PWD}/setup.js --max-old-space-size=4096" npm test`, `MSG="a $(date) b c" npm test`) no longer hides the command. Documented gaps: an option that takes a value and is not listed (`npm --registry URL test`) hides the command, and so does `git -C "$(git rev-parse --show-toplevel)" push`, whose raw split puts the quote's two halves in different segments; a multi-word quoted value split at `;`, `|`, `&`, a newline, `(` or `{` (`FOO="a;b c" npm test`: the forward scan runs only after `)`, `}` or a backtick), a single-quoted value whose closing quote is glued to a contraction-shaped suffix (`'s`, `'t`, `'d`, `'m`, `'re`, `'ve`, `'ll`), because the suffix is not counted as a quote (`FOO=a'b;c'd npm test`), a versioned interpreter or an interpreter option before `-m` (`python3.12 -m pytest`, `python -X dev -m pytest`), and a GNU long option that takes a separate argument (`timeout --signal KILL 600 npm test`, `env --unset FOO npm test`) do too. With the default patterns, matching is linear in the length of the command. This is not shell parsing: no expansion, no aliases, no functions.

  Defaults: `npm ci|install|i|test|t`, `npm run test|build|typecheck|lint|ci…`, `npx vitest|jest|tsc|playwright` (npm and npx accept options first: `--prefix`/`-C`, `--workspace`/`-w` and `--package`/`-p` with a value, other options alone or as `--name=value`, as in `npm --prefix app test` and `npx -y tsc`), bare `vitest`/`jest`/`tsc`, `node --test`, `pytest`, `uv run … pytest|mypy`, `mypy`, `python[3] -m pytest|mypy|pip install`, `pip[3] install`, `uv sync|pip install`, `[xcrun] xcodebuild`, `swift build|test`, `cargo build|test|check|clippy`, `gradlew`, `go build|test|vet`, `deno test`, `make`, `scripts/test*.sh`, `scripts/ci` (a repo's declared local CI; run it directly, since `sh scripts/ci` makes `sh` the command word and is not heavy), and `git push` (pre-push hooks; git's `-C <dir>` and `-c <key=value>` options may precede `push`, and an unquoted value may contain quoted spans: `-c core.sshCommand='ssh -i key'`). A pattern must end at a word boundary: it is not followed by a word character, `.`, `/` or `-`, so `./make/foo.sh` and `vitest.config.ts` are not heavy. Extra patterns from `CO_LEASE_PATTERNS_FILE` are tested at the same command word with the same end boundary, so an extra `pnpm run test` does not match `pnpm run test-unit`; write `pnpm run test[\w:-]*` to include it. The matcher is exported as `isHeavyCommand(command, extraPatterns?)`.
- `CO_LEASE_PATTERNS_FILE` names a JSON array of extra patterns (regex sources, tested at the same command word). A missing or malformed file, or a pattern that is not a regex, adds nothing.
- `claude-orchestrator-lease hook --print-settings-entry` prints the `hooks` settings to install as JSON: one `Bash` entry each for `PreToolUse` (`timeout: 500`), `PostToolUse` and `PostToolUseFailure`. Each runs the gate and a word pre-filter in the shell, so most Bash calls never start `node` (the pre-filter is bypassed while `CO_LEASE_PATTERNS_FILE` is set). The pre-filter is `grep -E` over the whole hook JSON, so on `PostToolUse` it also sees the tool's output; each default pattern contributes a short ERE that every command it matches contains (`git.*push`, `node --test`, `go (build|test|vet)`, `uv (sync|pip)`, and the bare tool names, which must end at a word boundary, so `tsconfig.json` and `git status` never start `node`). The line points at the `cli-lease.js` of the build that printed it, not at `CO_HOME`: that path is the printing build's own location, so print the entries again and install them after that build moves (a removed worktree, a cleared npx cache, a rebuilt `dist/`). When the file is gone, a call that passes the pre-filter exits 0 and prints one stderr line naming the path and saying to print and install the entries again, instead of a stack trace. Two installs from different builds each run for every call; they share one slot, because an id whose holder is live is admitted at once. Installing it is your step; nothing here edits `~/.claude/settings.json`.

## Quick Start

### 1. Create a YAML config

```yaml
# orchestrator.yaml
name: "My Orchestrator"
configDir: "./my-orchestrator"
worktreeDir: "./worktrees"
projectRoot: "."
stallTimeout: 1800
allowedTools: [Bash, Read, Write, Edit]

branchPrefix: "feature/"
retryableStatuses: [failed, interrupted]
promptTemplate: "./prompt.md"       # supports {{ISSUE_NUMBER}}, {{SLUG}}, {{DESCRIPTION}}, {{projectRoot}}
claudeArgs:
  - "--add-dir"
  - "{{projectRoot}}"

postSessionCheck:
  commands: ["npm test", "npx tsc --noEmit"]
  cwd: "scripts"                    # relative to worktree root

summary:
  title: "Status"
  columns:
    - { header: "Issue", width: 6, value: "issue.number", prefix: "#" }
    - { header: "Description", width: 30, value: "issue.description" }
    - { header: "Wave", width: 6, value: "issue.wave" }
    - { header: "Status", width: 14, value: "status" }

issues:
  - { number: 1, slug: setup, dependsOn: [], description: "Initial setup" }
  - { number: 2, slug: api, dependsOn: [1], description: "Build API layer" }
  - { number: 3, slug: ui, dependsOn: [1], description: "Build UI components" }
  - { number: 4, slug: deploy, dependsOn: [2, 3], description: "Deploy to prod" }
```

Paths are resolved relative to the YAML file's directory. Most hooks are derived automatically from the YAML fields (branch naming, retry logic, summary table, prompt interpolation, etc.).

### 2. Wire it up

`setUpWorktree` and `removeWorktree` have no universal default and must be provided as hook overrides:

```typescript
// orchestrate.ts
import { createMain, loadYamlConfig } from "@funlandresearch/claude-orchestrator";
import type { HooksOverride } from "@funlandresearch/claude-orchestrator";

const hooksOverride: HooksOverride = {
  async setUpWorktree(issue) { /* create git worktree + install deps */ },
  async removeWorktree(issue) { /* remove git worktree */ },
};
```

#### Cross-repo checkouts: `deriveWorktreeHooks`

For a DAG that spans repos, wiring `setUpWorktree`/`removeWorktree` by hand is repetitive. `deriveWorktreeHooks` packages the common shape — locate each issue's checkout, fork a branch off that repo's own base branch, and place the worktree in the sibling `<repo>-worktrees/` directory:

```typescript
import { deriveWorktreeHooks } from "@funlandresearch/claude-orchestrator";
import type { HooksOverride } from "@funlandresearch/claude-orchestrator";

// Defaults: reposDir = ~/Developer/WXYC, branch = orchestrator/<slug>,
// base branch derived per-repo from `git rev-parse --abbrev-ref origin/HEAD`.
const hooksOverride: HooksOverride = { ...deriveWorktreeHooks() };
```

Each issue's `repo` (`owner/repo`, e.g. `WXYC/library-metadata-lookup`) resolves to the checkout `<reposDir>/library-metadata-lookup` — the owner is the parent directory. The base branch is **derived, never assumed**: a repo whose `origin/HEAD` points at `master` (such as `wxyc-ios-64`) forks from `origin/master`, while repos on `main` fork from `origin/main`. Forking from the `origin/` remote-tracking ref (rather than the local branch of the same name) starts each worktree from the freshest fetched state. Override any of `reposDir`, `repoOf`, `worktreeRoot`, `baseBranchOf`, or `getBranchName` to fit a different layout:

```typescript
const hooksOverride: HooksOverride = {
  ...deriveWorktreeHooks({
    reposDir: "/srv/checkouts",
    baseBranchOf: (repoDir) => (repoDir.endsWith("wxyc-ios-64") ? "origin/master" : "origin/main"),
  }),
};
```

`deriveWorktreeHooks` only lays out the worktree; it installs no dependencies. When a repo's `postSessionCheck` needs them (e.g. `npm test`), wrap `setUpWorktree` to install after the worktree exists:

```typescript
const wt = deriveWorktreeHooks();
const hooksOverride: HooksOverride = {
  ...wt,
  async setUpWorktree(issue) {
    await wt.setUpWorktree(issue);
    execFileSync("npm", ["ci"], { cwd: wt.getWorktreePath(issue), stdio: "pipe" });
  },
};
```

createMain({
  configs: {
    myconfig: (projectRoot) =>
      loadYamlConfig(`${projectRoot}/orchestrator.yaml`, { hooksOverride }),
  },
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

#### Per-repo settings: the `repos:` map

`deriveWorktreeHooks` places each repo's worktree correctly; the `repos:` map handles the other half — that each repo has its own base branch, CI profile, and collision domains. Keyed by `owner/repo`, every entry may override `baseBranch`, `postSessionCheck`, `sequentialPaths`, and `appendableFiles` for the issues that declare that `repo` (or inherit it from `defaultRepo`):

```yaml
defaultRepo: WXYC/Backend-Service
baseBranch: main                       # top-level default for every repo
postSessionCheck:
  commands: ["npm run ci:testmock"]    # default check profile
repos:
  WXYC/wxyc-ios-64:
    baseBranch: master                 # iOS forks from master, not main
    postSessionCheck:
      commands: ["xcodebuild test -scheme WXYC"]
  WXYC/library-metadata-lookup:
    postSessionCheck:
      commands: ["ruff check .", "pytest -q"]
issues:
  - { number: 924, slug: lml-perf, dependsOn: [], description: "...", repo: WXYC/library-metadata-lookup }
  - { number: 685, slug: ios-tab, dependsOn: [924], description: "...", repo: WXYC/wxyc-ios-64 }
```

Resolution is **replace, not deep-merge**: an entry that sets `postSessionCheck` uses only its own commands, and one that omits a field inherits the top-level value for it. The resolved `baseBranch` flows into that repo's collision diffs, counter seeding, **and the merge step's intra-wave rebase** — so a merged iOS PR is rebased onto `origin/master` and a Backend-Service one onto `origin/main`, and each PR's conflict-resolution prompt names its own base. (Without this, a cross-repo `after-wave` merge would rebase every PR onto `origin/main`, which doesn't exist for a `master`-based repo.) Collision detection also considers only same-repo peers, since files in different repos can't collide. A `repos:` key that no issue references (nor `defaultRepo`) is a hard load error — an unused key is almost always a typo that would otherwise silently leave the real repo on the wrong base branch.

#### Per-issue model & effort

Each issue runs its own implement session, so each picks its own model and effort tier rather than sharing one model for the whole run. The default is **Sonnet**, with effort set by an optional `complexity` tag (`mechanical`→`low`, `normal`→`medium`, `complex`→`high`). Set `defaultModel`/`defaultEffort` at the top level to move the baseline, and override per issue with `model`, `effort`, or `complexity`:

```yaml
defaultModel: sonnet     # baseline model for every issue (default: sonnet)
defaultEffort: medium    # baseline effort when an issue sets neither effort nor complexity

issues:
  - { number: 1, slug: bump-dep, dependsOn: [], description: "Bump lodash", complexity: mechanical }   # sonnet / low
  - { number: 2, slug: api, dependsOn: [1], description: "New endpoint", complexity: normal }           # sonnet / medium
  - { number: 3, slug: migration, dependsOn: [1], description: "Schema change", complexity: complex }   # sonnet / high
  - { number: 4, slug: hairy, dependsOn: [1], description: "Concurrency rework", model: opus, effort: max }
  - number: 5
    slug: ios-feature
    dependsOn: [1]
    description: "iOS On Tour tab"
    repo: WXYC/wxyc-ios-64
    extraDirs: ["../wxyc-shared"]   # extra read-only dirs (`--add-dir`); relative paths resolve against the config file
```

Precedence for effort is explicit `effort` → `complexity` tier → `defaultEffort` → `medium`. A [CI-failure retry](#ci-failure-retry) bumps effort one tier per attempt (capped at `max`) while keeping the model — subject to the guardrail below. That guardrail: a Haiku-class model resolved to `high` effort or above is promoted to Sonnet instead — a weak model straining costs more per token than a stronger model deliberating less. `model` accepts an alias (`haiku`/`sonnet`/`opus`) or a full model id.

On the implement and retry spawns, a config's `claudeArgs`/`getClaudeArgs` output is appended after these, so it can still override the model via the CLI's last-`--model` rule; the merge-conflict resolver always runs at the issue's own tier. This Sonnet-tiered baseline replaces the previous hardcoded Opus for **every** config, including a programmatic `OrchestratorConfig` with no `model`/`defaultModel` — a bare config that ran Opus before now runs Sonnet. Set `model: opus` (per issue) or `defaultModel: opus` (run-wide) to opt back in.

#### Mode-nodes: `deploy` / `publish` / `gate`

Not every DAG node is a code change. A **mode-node** runs a configured shell `command` instead of spawning a Claude session — no worktree, no model/effort — so a cross-repo run can model deploy/publish steps as first-class nodes with real dependency ordering. Its `command`'s exit code is the outcome: `0` marks the node succeeded (releasing its dependents), any non-zero marks it failed (the node records the real exit code and logs the command's `stderr`/`stdout`, so a failed deploy is diagnosable). Because the command is the whole node, prefer a self-contained trigger (`gh workflow run …`) over anything that assumes a checkout. The command is bounded by the node's `stallTimeout` (per-issue, else the config default; `0` disables the bound) so a hung command can't block the engine — set it higher for a command that legitimately blocks, e.g. one that waits on a deploy.

```yaml
issues:
  - { number: 924, slug: lml-perf, repo: WXYC/library-metadata-lookup, dependsOn: [], description: "LML lane isolation", complexity: complex }
  - number: 1
    slug: deploy-lml
    repo: WXYC/library-metadata-lookup
    mode: deploy
    command: "gh workflow run deploy.yml -R WXYC/library-metadata-lookup"
    dependsOn: [924]                       # deploys only after the implement node lands
  - number: 82
    slug: canary-validate
    repo: WXYC/wxyc-canary
    mode: gate
    command: "gh workflow run canary-smoke.yml -R WXYC/wxyc-canary"
    dependsOn: [1]                         # validates the live deploy
```

`mode` accepts `deploy`, `publish`, or `gate` (an unrecognized value is a load error). A mode-node never has a PR, so the merge step skips it, and cleanup leaves it alone.

##### The cutover gate (cross-repo HITL)

"Satisfied" isn't "consumable" across a repo boundary: a merged upstream PR isn't live downstream until it's published or deployed. So before releasing an issue, the engine stops for a **cutover confirmation** when either:

- the issue is a **command-less mode-node** — a pure manual gate (`mode: gate` with no `command`) the engine can't run itself, e.g. "deploy by hand, then confirm"; or
- the issue has a **bare cross-repo dependency** — a dep in another repo that's a plain Claude node. (If that cross-repo dep is instead a mode-node, no extra confirmation is needed: a command node's exit-0 *is* the cutover, and a manual gate's own confirmation already served as one.)

Confirmation comes from an optional `confirmCutover(issue, reason)` hook (return `true` to release, `false` to hold). **When the hook is absent, gated issues hold** — they're left `pending`, their dependents skip, and a later full re-run (`run-all`, once the upstream is live or with the hook wired) re-evaluates the gate and picks them up. Note that `--retry-failed` does **not** resume a held gate — a held gate is `pending`, not `failed`, so only a full `run-all` revisits it; the end-of-run summary lists what was held. This is the conservative default: a cross-repo run must wire `confirmCutover`, or model explicit command mode-nodes, to progress unattended. So `publish → BS consumes → deploy → canary` flows automatically when the publish/deploy/canary steps are command mode-nodes, and only a raw cross-repo hand-off pauses for a human.

### 3. Run it

```bash
npx tsx orchestrate.ts myconfig              # Run all waves (up to 4 in parallel)
npx tsx orchestrate.ts myconfig --plan       # Preview the wave partition (read-only)
npx tsx orchestrate.ts myconfig --parallel 8 # Run up to 8 issues concurrently
npx tsx orchestrate.ts myconfig --no-adaptive # No warning adaptation or hysteresis (critical still stops)
npx tsx orchestrate.ts myconfig --status     # Show status table
npx tsx orchestrate.ts myconfig --wave 1     # Run wave 1 only
npx tsx orchestrate.ts myconfig 1 2 3        # Run specific issues
npx tsx orchestrate.ts myconfig --retry-failed
npx tsx orchestrate.ts myconfig --merge      # Merge succeeded PRs
npx tsx orchestrate.ts myconfig --watch      # Live dashboard
npx tsx orchestrate.ts myconfig --detach     # Run in background
npx tsx orchestrate.ts myconfig --tail       # Reattach to background run
npx tsx orchestrate.ts myconfig --cleanup    # Remove worktrees and logs
```

## Programmatic Configuration

For full control, you can skip the YAML file and build configs in TypeScript:

```typescript
// orchestrate.ts
import { createMain, validateConfig, createPrintSummary } from "@funlandresearch/claude-orchestrator";
import type { IssueSpec, OrchestratorConfig } from "@funlandresearch/claude-orchestrator";

const ISSUES: IssueSpec[] = [
  { number: 1, slug: "setup",  dependsOn: [],  description: "Initial setup" },
  { number: 2, slug: "build",  dependsOn: [1], description: "Build pipeline" },
  { number: 3, slug: "deploy", dependsOn: [2], description: "Deploy to prod" },
];

function createMyConfig(projectRoot: string): OrchestratorConfig {
  return validateConfig({
    name: "My Orchestrator",
    configDir: `${projectRoot}/my-orchestrator`,
    worktreeDir: `${projectRoot}/worktrees`,
    projectRoot,
    stallTimeout: 1800,
    issues: ISSUES,
    hooks: {
      showHelp() { console.log("Usage: npx tsx orchestrate.ts myconfig [options]"); },
      shouldSkipIssue() { return { skip: false }; },
      isRetryableStatus(s) { return s === "failed" || s === "interrupted"; },
      async preflightCheck() {},
      async preRunSetup() {},
      async setUpWorktree(issue) { /* create git worktree */ },
      async removeWorktree(issue) { /* remove git worktree */ },
      getWorktreePath(issue) { return `${projectRoot}/worktrees/${issue.slug}`; },
      getBranchName(issue) { return `feature/${issue.slug}`; },
      async interpolatePrompt(issue) { return `Fix issue #${issue.number}: ${issue.description}`; },
      getClaudeArgs() { return []; },
      printSummary: createPrintSummary({
        title: "Status",
        columns: [
          { header: "Issue", width: 6, value: (i) => "#" + i.number },
          { header: "Description", width: 30, value: (i) => i.description },
          { header: "Status", width: 14, value: (_, s) => s },
        ],
      }),
    },
  });
}

createMain({
  configs: { myconfig: createMyConfig },
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

`ConfigFactory` accepts both sync and async return values, so `loadYamlConfig` (async) and `validateConfig` (sync) both work directly with `createMain`.

## Architecture

The engine uses dependency injection for all external interactions:

- **`StatusStore`** - Read/write issue statuses (file-backed or in-memory)
- **`MetadataStore`** - PR URLs, exit codes, timing, files changed
- **`ProcessRunner`** - Spawn Claude processes
- **`Logger`** - Console output
- **`OrchestratorHooks`** - Project-specific behavior (worktree setup, prompts, etc.)

All behavioral tests run in-memory without spawning real processes.

### What `succeeded` means

`succeeded` is a claim that the run's work landed, not that its process exited cleanly — an agent that ends its turn mid-task exits 0. Before recording it, the engine counts commits on the issue's branch (`git rev-list --count origin/<base>..HEAD`, with `<base>` from the `getBaseBranch` hook); a clean exit over a branch holding zero commits is recorded as `failed`. When the count can't be determined at all — worktree already removed, no `origin/<base>` ref, git unavailable — the engine warns and leaves the session's own result in place. Only positive evidence of zero commits downgrades a run.

The PR a session opened is recovered by scraping its log, and is verified before it is recorded. Candidates are filtered to the issue's own `owner/repo` — which requires a repo to compare against, so the filter applies only when the issue carries a `repo` or the run sets `defaultRepo`; without either, every PR URL in the log stays a candidate and the identity check below is the only thing standing between a quoted URL and the store. Each candidate is then checked newest-first with `gh pr view <n> --repo <owner/repo> --json state,headRefName`, which must confirm the PR exists, is open, and has this run's branch as its head; the first that passes is recorded. Verifying more than one matters because the log is appended across retries and a same-repo PR URL can be printed *after* the real one (upstream handoff notes quoted into `UPSTREAM_CONTEXT` do exactly that), so a single rejection is not proof the session opened nothing. If none verify, the scrape is dropped with a warning and existing metadata is left untouched. This matters beyond reporting — `--merge` hands `metadata.prUrl` straight to `gh pr merge`, so a PR URL merely quoted somewhere in a multi-megabyte transcript must never reach it.

### Wave Scheduling

Issues declare dependencies via `dependsOn`. The engine computes waves using
topological sort: wave 1 has no dependencies, wave 2 depends on wave 1, etc.
Within a wave, issues run in parallel up to `--parallel N`.

#### Caveat: parallel issues that produce sequentially-numbered files

Two issues running in the same wave each see the same `origin/main` checkout. If both create a sequentially-numbered file by reading the highest existing number and adding one (Drizzle migrations `NNNN_*.sql`, Rails-style migrations, knex, append-only changelogs, etc.), they will independently pick the **same** number. The collision only surfaces at merge time, requiring manual renumbering of the second PR.

Workaround: mark issues that produce these artifacts as `serial: true` in YAML (or set `serial: true` on the `IssueSpec` programmatically). A serial issue runs alone in its own wave — no other issue runs in parallel with it. Within each base wave, all non-serial issues run together first, then each serial issue runs by itself in issue-number order. Issues in later base waves wait until all serials in earlier base waves finish.

```yaml
issues:
  - { number: 1, slug: schema-column,  dependsOn: [], description: "Add column X", serial: true }
  - { number: 2, slug: scheduled-job, dependsOn: [], description: "Add cron job", serial: true }
  - { number: 3, slug: ui-tweak,      dependsOn: [], description: "Tweak button" }             # runs in parallel with #4
  - { number: 4, slug: docs-update,   dependsOn: [], description: "Update README" }            # runs in parallel with #3
```

This is a brute-force serialization — an issue that only depends on a non-serial sibling will still wait until any serial siblings in the same base wave finish. Use it sparingly, only on issues that genuinely conflict on shared sequential state.

#### Detection: `sequentialPaths` collision check

For projects that don't want to give up parallelism but do want a safety net, configure `sequentialPaths` to detect collisions in `postSessionCheck`. After each session completes successfully (and any configured `commands` pass), the orchestrator scans the current branch's added files matching the pattern, then walks peer worktrees and `origin/<baseBranch>` for the same captured key. On a collision, the session is marked failed; if `retryOnCheckFailure` is enabled, the failure context — including the suggested next-safe number — is injected into the retry prompt.

```yaml
baseBranch: main           # optional, defaults to "main"; override per repo under `repos:`
sequentialPaths:
  - dir: shared/database/src/migrations
    pattern: "(\\d{4})_.*\\.sql"
```

`baseBranch`, `postSessionCheck`, `sequentialPaths`, and `appendableFiles` can all be overridden per repo via the [`repos:` map](#per-repo-settings-the-repos-map) — in a cross-repo DAG the scan targets each issue's repo base branch (iOS `origin/master`, others `origin/main`) and only same-repo peers.

The pattern must compile as a JavaScript regex and contain at least one capture group; group 1 is the unique key (typically a zero-padded number). Multiple `sequentialPaths` entries are independent number spaces.

This is **detection, not synchronization**. Two parallel issues finishing near-simultaneously can both fail the check; that's the documented limitation. Detection complements `serial: true` rather than replacing it: keep `serial: true` for high-collision-risk issues, and let detection catch the rest.

#### Coordination: `sequentialDomains` + `claim` CLI

For guaranteed-unique numbering — the synchronization that detection alone can't provide — configure `sequentialDomains` and instruct agents to claim a number from the orchestrator instead of computing one locally. The orchestrator hands out monotonically-increasing numbers per domain, persisted in `<configDir>/counters/<domain>.json`, with a per-domain lockfile so concurrent claims (across parallel sessions or the orchestrator's `--detach` background mode) are safe.

```yaml
baseBranch: main
sequentialDomains:
  migrations:
    paths:
      - dir: shared/database/src/migrations
        pattern: "(\\d{4})_.*\\.sql"
    width: 4   # zero-padding for the formatted output (e.g. "0057")
```

When `sequentialDomains` is set, the orchestrator exposes a `{{CLAIM_NUMBER}}` template variable that resolves to a partial command:

```
node /abs/path/to/dist/src/cli-claim.js --config <yaml> --issue <n> --domain
```

Your prompt template instructs the agent to invoke the helper with the desired domain appended, e.g.:

```text
Before writing a migration file, claim a number:

  num=$({{CLAIM_NUMBER}} migrations)

Then write the file as `shared/database/src/migrations/${num}_<slug>.sql`.
```

The helper prints just the formatted number (`0057`) to stdout. Claims are idempotent per `(domain, issueNumber)` so a retry of the same session reuses the same number rather than burning a new slot.

On the first claim for a domain the counter is seeded by scanning `origin/<baseBranch>` for the highest existing key, so `0001-0056` already on `main` correctly produces `0057` as the first hand-out. The seed runs once per domain; if migrations are merged out-of-band between orchestrator runs, delete the affected `<configDir>/counters/<domain>.json` to force a re-seed.

`sequentialDomains` and `sequentialPaths` are independent and complementary: claim is the primary synchronization, detection is the backstop in case an agent skips the claim step. Both can be configured together.

### Hook Interface

Each config provides an `OrchestratorHooks` object:

| Hook | Description |
|------|-------------|
| `showHelp()` | Print usage text |
| `shouldSkipIssue(issue)` | Return `{ skip, reason? }` to skip issues |
| `isRetryableStatus(status)` | Which statuses `--retry-failed` retries |
| `preflightCheck()` | Validate environment before running |
| `preRunSetup()` | One-time setup (e.g., cache issue bodies) |
| `setUpWorktree(issue)` | Create git worktree and install deps |
| `removeWorktree(issue)` | Remove git worktree |
| `getWorktreePath(issue)` | Return worktree directory path |
| `getBranchName(issue)` | Return branch name for the issue |
| `interpolatePrompt(issue)` | Build the Claude prompt |
| `getClaudeArgs(issue)` | Extra CLI args for claude |
| `printSummary(issues, getStatus)` | Display status table |
| `postSessionCheck?(issue, path, ctx?)` | Optional post-session validation (returns `PostCheckResult` with `passed`, `summary`, `output`, and `stopped` when it did not run at `critical` memory pressure). `ctx` is a `PostSessionCheckContext` (`{ lease?: LeaseOptions; runningSessions?(): number }`): with `ctx.lease` a check takes one lease slot with `acquireLease({ ...ctx.lease, inheritedHolderId: undefined }, …)` (`stopWhen` from `stopAtCritical(level, live + runningSessions())`), must report each child's PID through `setChildPid`, and must not block the event loop. A check that ignores `ctx.lease` runs unleased. |
| `onStatusChange?(issue, old, new)` | Optional hook called on every status transition (used by label sync) |

### Agent-to-Agent Communication

Upstream agents can write a `HANDOFF.md` file in their worktree root. When downstream issues start, the orchestrator reads `HANDOFF.md` from each dependency's worktree and injects the content into the prompt template via `{{UPSTREAM_CONTEXT}}`.

### GitHub Integration

- **Issue comments**: Set `issueComments: { repo: "owner/repo" }` in YAML to post run summary comments on GitHub issues after each run.
- **Label sync**: Set `labelSync: { prefix: "orchestrator" }` in YAML to sync status labels (e.g., `orchestrator:running`, `orchestrator:succeeded`) on GitHub issues as statuses change.

### CI Failure Retry

Set `retryOnCheckFailure: { maxRetries: 2 }` in YAML to automatically retry agent sessions when `postSessionCheck` fails. The failure output is injected into the retry prompt so the agent has context to fix the issues. Each retry also escalates the session's [effort](#per-issue-model--effort) one tier (capped at `max`), keeping the model fixed (except the Haiku guardrail, which may promote a weak model to Sonnet once effort reaches `high`).

### Task Decomposition

Use `--decompose` to invoke an LLM to break a feature description into structured issues:

```bash
echo "Add user authentication with OAuth" | npx tsx orchestrate.ts myconfig --decompose
npx tsx orchestrate.ts myconfig --decompose --file spec.md
npx tsx orchestrate.ts myconfig --decompose --issue 42 --repo owner/repo
npx tsx orchestrate.ts myconfig --decompose --file spec.md --create-issues --repo owner/repo
```

### Web Dashboard

Use `--dashboard` to start a read-only HTTP dashboard with live status updates:

```bash
npx tsx orchestrate.ts myconfig --dashboard              # http://127.0.0.1:3000
npx tsx orchestrate.ts myconfig --dashboard --port 8080   # custom port
```

The dashboard shows issues grouped by wave with status badges, PR links, and expandable log tails. Updates are streamed via Server-Sent Events.

## Test Utilities

Import test helpers from `claude-orchestrator/testing`:

```typescript
import { InMemoryStatusStore, InMemoryMetadataStore, createSilentLogger, scriptedPressureSampler } from "@funlandresearch/claude-orchestrator/testing";
```

`scriptedPressureSampler(levels, options?)` builds a fake `PressureSampler`: `levels` is one level, a list (one level per reading, then the last one held), or a function read on every call. `options.fresh` makes `fresh()` disagree with the cached reading, and `options.overridden` adds `overridden()`.

## Development

```bash
npm test           # Run tests
npm run typecheck  # Type-check
npm run build      # Build to dist/
```

## License

MIT
