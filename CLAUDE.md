## @funlandresearch/claude-orchestrator

TypeScript engine for launching parallel headless Claude sessions against
GitHub issues. Published as an npm package for reuse across projects.

### Structure

```
src/
├── types.ts              # All types and interfaces
├── engine.ts             # Orchestrator class, cleanUpMergedIssues
├── schema.ts             # Zod validation + validateConfig()
├── dag.ts                # Wave assignment: computeWaves() — wraps topo.ts, adds ownsFiles/serial splitting
├── topo.ts               # Shared topological-sort core: readySet / layeredTopoSort (ship-dag's planner adopts it in C2b)
├── ref.ts                # Composite issue identity: refOf / normalizeDep / encode/decode / compareRef / compareRefString
├── cli.ts                # Argument parsing (pure function)
├── status.ts             # Status/metadata stores (file-backed + in-memory)
├── process-pool.ts       # Parallel process management
├── stall-monitor.ts      # Log file growth monitor
├── log.ts                # Colored console logging
├── summary.ts            # Data-driven summary table renderer
├── watch.ts              # Live terminal dashboard
├── pr-tracker.ts         # PR URL extraction from logs
├── merge.ts              # PR merge with rebase onto each PR's per-repo base branch
├── run-history.ts        # Run record persistence
├── dependency-files.ts   # Dependency file detection
├── report.ts             # Post-run report generation (`ran`/`sessionIds` per row, from `Orchestrator.launchedSessions()`)
├── memory-pressure.ts    # Memory-pressure level reader, readMemorySignals() (level + free % in one guarded sysctl call, swap values and `hw.memsize` from a separate optional one: `memsize` is asked for until one read succeeds, cached for the process (`resetMemsizeCache` clears it for tests) and carried by every later reading as `memsizeBytes`; `reservePctFromEnv` parses `CO_LEASE_RESERVE_PCT`, integer 0–99, default 25; `freeBytes(signals)` (`memsizeBytes × freePct / 100`, `undefined` when either is absent), `usableBytes(memsize, pct)`, the base of the heavy class's proportional byte budget: it admits floor(ceiling × step / 4) unmatched holders (at least one above step 0), equal to the count rule only at the default ceiling 4), heavy/session capacity tables, stop rule, cached sampler
├── headroom.ts           # headroomStep(signals, previous, nowMs, table) → { step, risingSince }: pure 0–4 step from the pressure level and free %, StepTable (warning bands clamped to 0..4 + riseHoldMs; DEFAULT_STEP_TABLE is the owner's Q1 table: warning 3 at ≥40% free, 2 at 30–39%, 1 below, rise held 60 s), a malformed `previous` treated as absent; `headroomCapacity(step, ceiling)`: step → heavy slots, `heavyBudget(step, usable)`: step → heavy bytes (`usable × step / 4`), proportional to the step whatever the ceiling, so it differs from `headroomCapacity` at a non-default ceiling
├── headroom-sampler.ts  # defaultHeadroomSampler(env, deps) → HeadroomSampler `() => { level, step, signals }` + `fresh()` + `overridden()`: the machine step shared through `<lease dir>/headroom.json` (`{ at, signals, step, risingSince }`, trusted while `isFresh(at, now, 10 s)`; a stored `step`/`risingSince` is validated and else treated as absent, and a stored or in-process record as old as a full climb (`riseHoldMs` × `MAX_STEP`) is ignored, so the step starts at the target; written by `writeLeaseRecord` with no lock, beside `level.json`; a failed guarded read steps from the last good reading under 60 s old, else `critical`, and is not written); `CO_PRESSURE_OVERRIDE` maps critical→warning and step 0→1 in the returned reading only, never in the file; the headroom record also carries `sampledAt` (when a line was last appended to `pressure.jsonl`); `sample()` appends a line (`level`, `freePct`, `freeBytes`, `swapUsedBytes`, `step`, `heavyLive`) when the validated previous record differs in level or step or by 5 free-% points, or when `sampledAt` is 60 s old (machine-wide heartbeat; a failed append or `heavyLive` count is swallowed); `heavyLive` is a `defaultHeadroomSampler` dep that `defaultLeaseOptions` supplies from `scanHolders`; `levelView(headroom)` is the `PressureSampler` view `defaultLeaseOptions` hands out as `level`
├── capacity-governor.ts  # createCapacityGovernor() — pressure readings → launch capacity (bounds pipelines), 60 s hysteresis, transition logging; optional `runId` + `onTransition` callback receive a `CapacityTransition` (`{ type: "capacity-transition", runId?, from, to, capacity }`), which the engine appends to `<lease dir>/pressure.jsonl` through `jsonlSink` (`Orchestrator.runId` is set by `runRegistered`)
├── lease.ts              # Machine-wide heavy-command lease: FIFO admission through `<lease dir>/waiting/<id>.json` tickets (`{seq,id,pid,label,gated,capacity,ceiling,override,ready}`: the owner's last computed capacity, the inputs of it (class `ceiling`, and `override` when its step was the per-process override's) and whether its gates passed; a ticket counts as ahead only while its owner could be admitted, its capacity re-evaluated with `class.capacity(machine step, t.ceiling)` (the machine step is 0 when this reader is overridden, and a ticket's `override` maps 0 to 1), so a rise of the step cannot let a younger waiter pass; `parseTicket` reads a wrongly typed `capacity`/`ceiling`/`ready` as absent; and a gated waiter is refused while any older such gated ticket waits, however many slots are free, and records itself `ready: false` (FIFO among gated tickets); a ticket without `capacity`/`ready` counts and one without `ceiling` is read by its `capacity`; weights (heavy class only, `LeaseClass.budget?(step, usable)`): when the reading's `signals.memsizeBytes` is known, `usable = usableBytes(memsize, LeaseOptions.reservePct ?? 25)`, `HolderMeta.weight`/`HolderRecord.weight`/`Ticket.weight` are bytes (missing or not a positive number = the unmatched weight `usable / ceiling`), a request is admitted when Σ live + Σ ready tickets ahead + its own weight ≤ budget (relative slack 1e-12) or when nothing is live or ahead and the step is above 0 (oversize-alone), a ticket counts as ahead at any step above 0 rather than by capacity, and a refused waiter's ticket records `weight`; unmatched holders are admitted floor(ceiling × step / 4) at a time (at least one above step 0), which equals the count rule `min(ceiling, step)` at the default ceiling 4 but not at another `CO_LEASE_SLOTS` (ceiling 8 step 1: weights 2, count 1; ceiling 2 step 2: weights 1, count 2); with `memsize` unknown every weight is 1 and the budget is the capacity (the count rule), and `SESSIONS` has no `budget` so it always counts; `seq` = highest existing + 1 under the mutex; refreshed on every poll; eligible = pid alive and mtime within 15 s by `isWithinWindow`; a waiter is admitted when tickets that count as ahead < capacity − live; stale tickets are passed over, dead-pid ones reaped; `attempt()`'s locked block also `sweepDeadTemps` the class's holder and waiting directories and the lease root (dead-writer `writeFileAtomic` temp files; the scanners and `leaseStatus` never delete); `tryAcquireLease` writes none and needs no ticket that counts as ahead; `HolderMeta.gated` adds heavy-queue's gates under the mutex (`gatesPass`: `cpuBusy(opts, nowMs)` → busy share or `null` (unknown CPU reads 0; a cold or stale `cpu.json` is `null`, which fails the poll) under 0.75 from `LeaseOptions.cpuTimes` and `cpu.json`, no live holder `suspended`, `markElapsed(dir, name, nowMs, ms)` true 20 s since the `lastAdmit` mark (a missing or future-dated mark counts as elapsed), which `writeMark(dir, name, nowMs)` stamps through `writeFileAtomic`; no-wedge admits the oldest gated waiter when nothing is live, never at step 0; constants, written with `writeFileAtomic`), and the ticket is removed after the holder is created, its removal guarded; borrowed/inherited holders never queue; `acquireLease` removes its ticket in a `finally`), capacity from `LeaseOptions.headroom` (`snapshot(opts, class)` is the one read, `class.capacity(step, class.ceiling(opts))`; absent → the step derived from the level (critical 0, warning `heavyWarning`, else 4); `fresh` for the stop rule's confirmation; `leaseStatus` adds `step`/`signals`, the `acquire` event `step`), holder classes (`LeaseClass`: `{ holders, waiting, ceiling(opts), capacity(step, ceiling), heartbeatOnly }`, passed through `scanHolders`, `scanTickets`, `writeTicket`, `removeTicket`, `createHolder`, `attempt` and `snapshot`; `HEAVY` is `holders/`+`waiting/` with `headroomCapacity`, `SESSIONS` is `sessions/`+`sessions-waiting/` (both through `ensureOwnSubdir`, created only by an acquire of that class) with `sessionHeadroomCapacity` (`headroom.ts`: step 4 `LeaseOptions.sessionSlots`, 3/2/1 → min(slots, 4/2/1), 0 → 0; `sessionSlotsFromEnv` parses `CO_LEASE_SESSION_SLOTS` like `CO_LEASE_SLOTS`, default 6) and `heartbeatOnly` liveness in `verdict` (no `expiresAt` branch, no child-PID fallback, so a stopped engine's slots free 90 s after its heartbeat stops); `acquireSessionLease(opts, SessionMeta, wait)` is the session acquire (no caller until #175; the override is the sampler's, applied once; `wait.stopWhen` sees session `live`/`capacity`), `leaseStatus` adds `sessions: { capacity, live }`), holder files, 30 s mtime heartbeat (90 s staleness) + child-PID liveness, admission, fail-open, detached holders (`HolderMeta.detached`: session PID + `expiresAt`, no heartbeat; `dead-session`/`expired` reaps; `releaseHolder` by id; an acquire of an id whose holder is live is admitted at once with a borrowed handle; id `{1,160}`, session PID and `expiresAt` validated) (acquireLease, leaseStatus)
├── lease-dir.ts          # The lease directory's one rule, no load-time side effects (imports only `node:fs`, `node:path`, `atomic-write.ts`, `ps.ts`): `isOwnDir(st)` (real directory, not a symlink, owned by this user), `ensureOwnSubdir(dir, name)` (create at 0700, tighten an owned one, refuse a symlink/non-directory/foreign one; `lease.ts` re-exports both), `writeLeaseRecord(dir, name, text, opts?)` (writes through `writeFileAtomic` only when `lstat(dir)` passes `isOwnDir`, never creates `dir`, returns whether it wrote; I/O errors propagate) — the one writer for root-level lease records (`level.json`), `readRecordDir(dir, sub)` (read-only: `{ stem, text, mtimeMs }[]` for the canonical `<pid>.json` files of an `isOwnDir` subdirectory — no leading zero, no temp name; each entry is opened `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and read from the descriptor only when `fstat` says a regular file this user owns, so a symlink, FIFO, socket, directory, foreign-owned or unreadable entry is skipped and never followed or waited on; a missing, symlinked or foreign one is empty; creates nothing) — the one reader under `readSuspensions` and the watchdog's `readEngines`, which keep their own body validation
├── engine-registry.ts    # createFileEngineRegistry() and the exported `REFRESH_MS` (30 s; imports `pidAlive` from `ps.ts`, nothing from `lease.ts`): `deps.engineRegistry` default — writes `engines/<pid>.json` (`{ pid, pgid, runId, logDir, stallTimeout, startedAt }`) under the lease directory at start, rewrites it every 30 s on an unref'd timer, removes it at stop, and sweeps dead-writer temp files from `engines/` at start (`isAlive` injectable); pgid via `ps` (injectable, `null` on failure), `engines/` created through `ensureOwnSubdir` (`lease-dir.ts`, the lease's 0700 rule shared with `holders/` and `waiting/`: create at 0700, tighten an owned directory, refuse a symlink, non-directory or foreign one; also creates a missing lease directory at 0700); I/O errors and refusals swallowed
├── lease-events.ts       # jsonlSink(dir, name, deps): the one JSONL append-and-rotate sink (`ROTATE_BYTES` 5 MB, one `<name>.1` generation, write failures swallowed); leaseEventSink() is it on <lease dir>/events.jsonl for the lease's onEvent seam, and `pressure.jsonl` is the memory-pressure history (headroom sampler samples and governor transitions)
├── lease-run.ts          # Load-time-free home of the lease CLI's run function (`RunArgs` front-end options `gated`/`background`/`suspendable`/`noSuspend` for heavy-queue: own holder, no ancestor borrow, `taskpolicy -b` in its own group with `pgid` recorded on the holder): parseLeaseArgs, runLeased, runStatus, cliLeaseDeps, `LeaseCliDeps` (moved verbatim from `cli-lease.ts`, which re-exports them); safe for other modules to import
├── cli-lease.ts          # claude-orchestrator-lease bin (`main` and the load-time entry check; the run function lives in `lease-run.ts`): run a command under the lease (exit 75 no slot, 78 misconfigured), `status` as JSON; before acquiring it borrows a live hook holder (`expiresAt` set) whose session PID is an ancestor (`LeaseCliDeps.ancestors()`, a bounded `ps` walk; any failure → normal acquire) through `inheritedHolderId` and prints `lease: running inside this session's hook slot (<id>)` (skipped when `CO_LEASE_HOLDER` is set); re-exports `formatAdmitted`/`formatNoSlot`
├── lease-messages.ts     # formatAdmitted()/formatNoSlot()/formatDiskFull(); `formatRefusal(refusal, status)`/`refusalStopReason(refusal)`/`refusalExitCode(refusal)` are the one classifier of a `LeaseRefusal` (text, `"disk-full" | "memory-critical"` stop reason, CLI exit 74/75) used by the hook and `runLeased`, so no caller compares `refused`; `formatPostCheckStop(refusal)` is the post-check's summary (memory-critical: `post-check: skipped because memory pressure is critical (<level>, <live> live); the check did not run and will not be retried`, with no `lease: no slot after` prefix and no rerun advice, since the stop is terminal; disk-full: `Post-session check not run: ` + `formatDiskFull`); formatDiskFull() (ENOSPC/EDQUOT refusal `refused: "disk-full"`: CLI exits 74; `brief` adds a live `statfsSync` line): the one text of the admitted and no-slot lines, shared by the CLI and the hook (no load-time work, so the barrel can import it; `cli-lease.ts` runs a startup check at load and must never be imported by the library)
├── suspensions.ts        # `claude-orchestrator-lease suspend|resume` (`parseSuspensionArgs`, `runSuspension`, `runSuspensionCli`; `cli-lease.ts` only dispatches) and the one owner of the record: `SuspensionRecord` (`{ pgid, by, reason, at, remindAt, leader }`), `suspensionFile(dir, pgid)`, `writeSuspension` (refuses an existing record atomically: a complete temp file is hard-linked to the final name, `EEXIST` is the refusal, the temp is removed on every path), `removeSuspension` (returns whether one existed) and `readSuspensions(dir)` (only canonical `<pid>.json` names, no leading zero, whose body validates (dates parse) and carries that pgid; skips temp/malformed files; creates nothing; a missing, symlinked or foreign dir reads as empty); no other module names `suspensions/` or builds a record. The record file (0600, via the temp-and-`linkSync` write; dir through `ensureOwnSubdir`) is written before `SIGSTOP`, and `SIGCONT` is sent before the record is removed; `--record-only` signals nothing; `--remind <n>m|<n>h` (default 2h, at most 720h, else exit 64). Refuses (exit 1) a non-pid, 0, 1, the caller's own group, any ancestor's group (walked through the same scan's `ppid` column; a link missing from the scan, or a chain that does not reach pid 1 within 64 steps, refuses), a group with a member owned by another user, and for `suspend` a group with no live members or an existing record. Ancestry/membership/uid/leader come from one `ps -axo pid=,ppid=,pgid=,uid=,command=` scan; `ps`, signals and clock are injected (`SuspensionDeps`); `leader` is `null` when the leader has exited; `resume` with no record still sends SIGCONT, and ESRCH still removes the record
├── watchdog.ts           # Watchdog core (sends no signal; no `kill` in its dependencies; `WatchdogDeps.statfs` optional, default `statfsSync`, feeds `brief`'s disk-full line): `check(deps)` scans once (`scanProcessTable`: `ps -axo pid=,ppid=,pgid=,uid=,stat=,etime=,command=` through `ps.ts`, 60 s; a throw or an empty table skips the cycle, keeps the state and logs the skip), builds a `Context` (procs, engine records with `fresh` = mtime within `ENGINE_FRESH_MS` (3 × the registry's exported `REFRESH_MS`) and `alive` = pid has a scan row for a process that started no later than the record's `startedAt` (from `etime`, 5 s slack; a later start is a reused pid, so the engine is dead), suspension pgids from `readSuspensions`, `stoppedSince`), runs `RULES` (`Rule = (Context) => Finding[]`; add a rule there, the reporters stay) and writes `watchdog.json` + `watchdog.brief` through `writeLeaseRecord` and appends `watchdog.log` (`O_APPEND | O_NOFOLLOW`, new findings only). Nothing is written unless `lstat(dir)` passes `isOwnDir`. Stopped group = every member's `stat` starts with `T`, in scope when it contains or descends from a `claude` process or is a live registered engine's group (`pgid` null → the scan's). Rules: `unrecordedStoppedGroup` (5 min after first seen, skipped with a suspension record), `stalledEngine` (stale record with a live pid: when the engine's own `stat` is `T`, 5 min after its last refresh; when it is running, once the record is older than its `stallTimeout` + 10 min (`STALLED_MARGIN_MS`; a healthy engine stops refreshing while a synchronous command blocks it), and never at `stallTimeout` 0; whatever the group's `stat`, since sessions share the engine's group; yields once the stopped-group rule reports the group, and skipped with a suspension record), `deadEngine` (stale record, pid not in the scan or held by a process that started after the record; `once` per `runId`, record left in place). Further rules: `dueReminder` (`Context.records`, the parsed `readSuspensions` output: `remindAt` passed and every member of the group in `c.procs` stopped, in any tree; a recorded group with no members is `stale-record:<pgid>`, `once`, record kept), `oldLeaseSuspension` (`by: "lease"`, `at` 30 min old, `LEASE_SUSPENSION_MAX_MS`), `silentEngine` (fresh record, `Engine.activityMs` = newest regular `<logDir>/*.log` mtime else `startedAt`, older than `stallTimeout` + `STALLED_MARGIN_MS`, key `silent:<runId>`, never at `stallTimeout` 0). `isClaude` matches the basename of the command's first word only. `runWatchdog(argv, deps)` dispatches `check` | `brief`
├── cli-watchdog.ts       # claude-orchestrator-watchdog bin: wires the real `ps`, clock and `leaseDirectory(process.env)` (exit 78 on a relative `CO_LEASE_DIR`) into `runWatchdog`
├── watchdog-install.ts   # Printers for the owner's install steps (installs nothing): `plistText` (LaunchAgent: `RunAtLoad` true, `StartInterval` 120, `taskpolicy -b <node> <checkout>/dist/src/cli-watchdog.js check`, `StandardErrorPath` `watchdog.err`, `EnvironmentVariables` `CO_LEASE_DIR` pinned to the print-time lease directory), `START_INTERVAL_S` (the plist's `StartInterval`) and `STALE_AFTER_INTERVALS` (3), `statusLineSnippet(dir, fraction)` (shell fragment: `watchdog.brief`, a `df -Pk` disk-full line with `DISK_FULL_FRACTION` substituted, and a stale line when `watchdog.json` is missing from an existing lease dir or its `stat -f %m` mtime is older than `START_INTERVAL_S × STALE_AFTER_INTERVALS`; no node; text from `diskFullText`), `isGitWorktree` (a `.git` file whose `gitdir:` is under `worktrees/`; a submodule or `--separate-git-dir` checkout is not one), `checkoutOf(binPath)` (two levels above the bin), `runPrint` (`print-plist` refuses from a worktree, exit 1; `print-status-line`); wired in `cli-watchdog.ts`
├── lease-weights.ts      # Weight rule table and the one lookup the hook and the CLI share: `loadWeightTable(env, warn)` (`<lease dir>/weights.json` or `CO_LEASE_WEIGHTS_FILE`, `[{ pattern, repo?, gb }]`; a missing file is silent, an unreadable or malformed one or an invalid entry gives one warning and valid entries are kept), pure `resolveWeight(command, cwd, table, lookup?)` (first rule whose unanchored case-sensitive `pattern` matches wins; `repo` is `owner/repo` against the normalized `origin` (`normalizeRemote`, case-insensitive) or, when absolute, the git toplevel; `GitLookup` is a 2 s bounded `git` call and a failure leaves only rules without `repo`; `gb * 2**30` bytes; `undefined` when nothing matches, so the lease applies its unmatched weight), `weightFor(command, cwd, env, warn)`; set on `HolderMeta.weight` by `lease-hook.ts` (warnings silent) and `lease-run.ts`
├── lease-hook.ts         # Hook mode (`claude-orchestrator-lease hook`): isHeavyCommand() — two rules: text that mentions the CLI (`cli-lease.js`/`claude-orchestrator-lease`) is never heavy (a command that only mentions it runs unleased), else a raw linear split on every separator (no quote/heredoc/comment tracking), leading words (`nohup`/`exec`/`command`, option tokens skipped after `env`/`time`/`nice`/`timeout` and `sh`/`bash`/`zsh` up to `-c`) stripped token by token, a failed word's multi-word tail skipped by one scan to its odd-quote token (run only in a segment after `)`, `}` or a backtick, so a value split at `;`, `|`, `&`, a newline, `(` or `{` still hides the command), anchored patterns (npm/npx options first, launcher forms such as `python -m pytest`); CO_LEASE_HOOK gate, settingsEntries() for `--print-settings-entry` (the printed line's `grep -E` pre-filter greps the hook JSON for each pattern's word, an ERE in `DEFAULT_PATTERNS`' first column whose spaces become a whitespace/quote gap, and a missing CLI path exits 0 with one stderr line); `runHook` handles three events on `tool_use_id` (`^[A-Za-z0-9_-]{1,128}$`, else silent): PreToolUse takes a detached holder `hook-<id>` (450 s wait, session PID from `CO_LEASE_SESSION_PID`, `expiresAt` = admission + call timeout + 60 s; admitted → `additionalContext`, no slot → deny with `formatNoSlot`, `run_in_background` denied, fail-open → silent), PostToolUse/PostToolUseFailure `releaseHolder` it; options are `defaultLeaseOptions(env, { warn: () => {} })`, so every error is silent
├── atomic-write.ts       # writeFileAtomic(file, text, { mode = 0o600, mtimeMs?, exclusive? }): temp file named per process and call (`<file>.<pid>.<hex>.tmp`), optional `utimesSync` before the rename, temp removed best-effort on every path (a failed removal never replaces the write's result); `exclusive: true` hard-links the temp file instead of renaming it, so an existing target throws `EEXIST` and is never replaced (`writeSuspension`); `tempOwnerPid(name)` is the one parser of the temp name and `sweepDeadTemps(dir, isAlive)` removes the temp files whose pid is dead (no other module builds or parses a temp name); the one writer for lease-directory JSON records (tickets, holders, engine registry, level.json), no load-time side effects
├── ps.ts                 # Load-time-free bounded `ps` reader: ps(args, { timeoutMs = 2_000 }) (trimmed stdout, stderr discarded, throws on failure), psField(pid, field), psAncestors(startPid, depth) (one `ps` call per link; failure ends the walk with what it found, so a caller that guards on the walk must not use it — the CLI's borrow walk only), and the one process-table reader: `PS_TABLE_ARGS` (`-axo pid=,ppid=,pgid=,uid=,stat=,etime=,command=`), `parsePsTable(text)` → `ProcRow[]` (`parseElapsed` for `elapsedMs`; a line that is not a row is skipped), `ancestry(rows, pid, max)` → `{ chain, complete }` (nearest first, pid 1 excluded; `complete` is false for a missing link or a chain not finished in `max` rows, so `suspensions.ts` fails closed and `watchdog.ts` uses the chain best-effort), and `isPid` (re-exported by `lease.ts`); callers keep their own text-in `ps`/`scan` dependency and timeout; used by lease-run.ts, lease-dir.ts, atomic-write.ts, engine-registry.ts, suspensions.ts and watchdog.ts; also the process-group twins, the one home of the group error rule and the only module that writes `kill(-`: `groupAlive(pgid, kill?)` (`kill(-pgid, 0)`: alive, or `EPERM`) and `signalGroup(pgid, signal, kill?)` (`kill(-pgid, signal)`: false on `ESRCH`, other errors propagate; both refuse a non-`isPid` pgid without calling `kill`, so `-0` or a negative never addresses every process; `yaml-hooks.ts`, `lease-run.ts` and `suspensions.ts` pass their injected `kill`), and `pidAlive(pid)` (`kill(pid, 0)`: alive, or `EPERM`; `lease.ts` re-exports it as it does `isPid`, so `engine-registry.ts` and with it the watchdog bin import no lease engine module, which `__tests__/watchdog-imports.test.ts` checks over `watchdog.ts`'s runtime imports; `counter-store.ts` and `create-main.ts` keep their own probes, whose error rules differ: only `ESRCH` is dead in the lock reap, any error is dead in the detach checks)
├── file-lock.ts          # tryLockOnce(): non-blocking O_EXCL mutex with mtime staleness (isWithinWindow is the shared freshness rule), token-checked release, turn-taking reapers (the lease's mutex)
├── claude-env.ts         # claudeSessionEnv() — child env for spawned `claude` sessions (auth/billing)
├── real-process-runner.ts # Real child_process spawner
├── create-main.ts        # Generic entry point factory (sync or async ConfigFactory)
├── interpolate.ts        # {{var}} template substitution
├── yaml-types.ts         # YamlConfig, HooksOverride types
├── yaml-schema.ts        # Zod schema for YAML config validation
├── yaml-hooks.ts         # deriveHooks() — YAML fields → OrchestratorHooks
├── yaml-loader.ts        # loadYamlConfig() — full YAML→config pipeline
├── worktree-hooks.ts     # deriveWorktreeHooks() — reusable per-repo checkout/worktree hooks
├── repo-settings.ts      # resolveRepoSettings() — per-repo baseBranch/CI/collision overrides (repos: map)
├── model-effort.ts       # resolveModelEffort() / perIssueSpawnArgs() — per-issue model/effort policy
├── mode-node.ts          # isModeNode/isCommandNode/isManualGate/cutoverReason — non-Claude nodes + cross-repo cutover gate
├── github.ts             # GitHub CLI wrapper (labels, comments)
├── upstream-context.ts   # HANDOFF.md reading for agent-to-agent context
├── issue-comments.ts     # Post run summary comments on GitHub issues
├── label-sync.ts         # GitHub label sync on status changes
├── decompose.ts          # LLM-driven task decomposition
├── decompose-types.ts    # Decompose input/output types
├── collision-check.ts    # Sequentially-numbered-file collision detection
├── counter-store.ts      # Per-domain counter store (in-memory + file-backed)
├── seed-from-git.ts      # Initial counter seed from origin/<baseBranch>
├── cli-claim.ts          # CLI helper for agents to claim a sequential number
├── dashboard.ts          # HTTP dashboard server with SSE
├── dashboard-types.ts    # Dashboard dependency/option types
├── dashboard-html.ts     # Self-contained HTML template
├── merge-appendable.ts   # Pure merge logic for append-only JSON array files
├── cli-merge-appendable.ts # claude-orchestrator-merge-appendable CLI (git driver + manual resolve)
├── index.ts              # Public API barrel export
└── testing.ts            # Test utility exports (in-memory stores, silent logger, scriptedPressureSampler)
```

### Key Patterns

- **Lease test fixtures**: `scriptedPressureSampler` (`src/testing.ts`) is the only way tests build a `PressureSampler`, and `scriptedHeadroomSampler` (same file; one reading, a list or a function, with `fresh`/`overridden` options) the only way they build a `HeadroomSampler`; `scriptedLease(...).opts()` sets `headroom: undefined` so a spread over `defaultLeaseOptions()` never keeps its real sampler; `__tests__/helpers/lease.ts` (not a suite — vitest runs `*.test.ts` only) holds `scriptedLease(dir, init?)` (the one way a test builds `LeaseOptions`: `.opts(over?)` wires the sampler, a one-slot policy, the fake clock's `now`/`sleep`, `isAlive` over `.alive`, and `onEvent`/`warn` into `.events`/`.warnings`, so no test restates those fields or falls back to `Date.now` and a real `process.kill(pid, 0)`; a row whose policy is the point passes its own), `isolatedLeaseEnv` (the integration suites' scrub of `CO_LEASE_*`/`CO_PRESSURE_*`; the guard's half for spawned processes), `installIsolatedHome()` (installed for every test file by the `setupFiles` entry `__tests__/helpers/isolate-home.ts`, registered in `vitest.config.ts`: it points `HOME`, `XDG_STATE_HOME` and `os.userInfo().homedir` at a per-test-file temp home (under a run-level directory that `global-setup.ts` removes at teardown, since vitest skips `afterAll` for a file whose tests are all skipped; the teardown also scans those homes and fails the run, after removing the root, if collection wrote under one) with an empty default lease directory planted, and an `afterEach` fails any test that left an entry under that home's `.local/state/claude-orchestrator` (a final check after the file's own `afterAll` hooks catches writes outside tests), so a test that resolves the default lease directory fails on any machine, whether or not the real one exists — this guard is the guarantee that no test touches the real lease directory; pass an explicit `mkdtemp` `CO_LEASE_DIR`, built inside the test), `failFsCall(name, match, code)` (the one fs fault injector: spies `fs[name]` for matching paths and calls `syncBuiltinESMExports`, returns the restore; new fault tests use it, `vi.mock("node:fs")` only where a hoisted hook is needed, as in `suspension-race.test.ts`), `unwritableLeaseDir(tmp)` (a lease dir whose `mkdir` fails with ENOTDIR, to force an I/O error), and `fakeLeaseClock` (starts at real `Date.now()`, and its `sleep` yields via `setImmediate` so a runaway acquire loop fails by timeout instead of hanging).
- **Dependency injection**: `Deps` interface for all external interactions. `Deps.engineRegistry` (`EngineRegistry`: `start(info)`/`stop()`; set only by `createRealDeps` for the dispatch modes; absent = records nothing) lets a watchdog outside the engine's tree find it: `createMain` runs the dispatch inside `Orchestrator.runRegistered(runId, run)`, which starts it with the largest `issue.stallTimeout ?? config.stallTimeout` (0 when any issue disables stall detection) and stops it in a `finally`, and the SIGINT/SIGTERM handler calls `stopEngineRegistry()`. A SIGKILLed engine leaves its record behind by design. Tests inject a fake; the default's test uses an explicit `mkdtemp` dir.
- **In-memory testing**: All behavioral tests use `InMemoryStatusStore`,
  `InMemoryMetadataStore`, `createSilentLogger`, and mock `ProcessRunner`
- **Wave scheduling**: `computeWaves()` layers `dependsOn` into waves, with same-file ownership detection via `ownsFiles` (issues in the same candidate wave that claim overlapping non-shared files are slid to later waves by ascending issue number). The topological sort itself lives in `topo.ts` (`layeredTopoSort` / `readySet`) — a single composite-keyed core that ship-dag's `plan-waves.mjs` imports in C2b, so the engine's planner and the skill's planner won't drift. `computeWaves` throws on any unplaced node (a cycle, or an out-of-scope dep); ship-dag wraps the same core to report `{waves, blocked, cyclic}` gracefully against a `done` frontier.
- **Session auth/billing**: The engine drives the `claude` CLI, never the Anthropic API — but the CLI reads credentials from the environment before falling back to the Claude Code login, so an exported `ANTHROPIC_API_KEY` would silently bill every session as API credits (visible as `"apiKeySource":"ANTHROPIC_API_KEY"` in a session's stream-json `init` event). `claudeSessionEnv()` (`claude-env.ts`) builds the child env for every `claude` launch: it strips `CLAUDE*` (nested-session detection, **except** `CLAUDE_CODE_OAUTH_TOKEN`, which is the headless/CI subscription credential) plus `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (billing), leaving other `ANTHROPIC_*` routing/config vars alone. Applied at all three launch sites — `real-process-runner.ts` (sessions), `create-main.ts` (`--decompose`), and `yaml-hooks.ts` (`onMergeConflict`); the two exec-based sites share `claudeExecOptions()` so neither can drop the env independently. Deliberately **not** applied to the `postSessionCheck` runner, which runs the project's own commands and may need those credentials — note the asymmetry, since the agent's own in-session Bash tool *does* get the scrubbed env. `claudeSessionEnv()` also strips `CO_LEASE_HOLDER`, so a session never inherits a lease holder id from the engine's environment (the engine itself ignores an inherited one: it acquires with `inheritedHolderId: undefined`, and the holder id reaches only the check's command child envs). `authBanner()` prints the resolved mode at run start and names any credential it dropped; it never claims a login it hasn't verified. Opt back in with `CLAUDE_ORCHESTRATOR_USE_API_KEY=1` (allowlist parse: `1`/`true`/`yes`/`on`, so typos fail closed) or `createRealProcessRunner({ useApiKey: true })`. `--detach` intentionally keeps its own narrow strip in `create-main.ts` — the child there is another orchestrator, which must inherit the opt-in var.
- **Memory-pressure adaptation**: `Deps.memoryPressure` (a `PressureSampler`; absent = `"unknown"`, today's behavior; only `createRealDeps` sets it, as `defaultLeaseOptions(process.env, { warn: consoleLogger.warn }).level` (the same sampler as `Deps.lease`, logging through the engine Logger with a `memory-pressure:` tag), and only for the modes that launch sessions — `run-all`, `run-specific`, `retry-failed` — so a relative `CO_LEASE_DIR` fails a run at startup but never `--status` or another read-only mode) drives `launchAndWait`. One run-scoped `createCapacityGovernor` (so the 60 s hysteresis spans wave boundaries) ticks every 10 s from a per-`launchAndWait` timer, cleared when it returns. The timer is unref'd except while a launch waits in `waitForSlot`: with nothing running it is the launcher's only waker, and an unref'd tick let Node exit mid-wave with no report. `ProcessPool` limits slots to `min(maxParallel, capacity())`, so the 0-byte fallback's `setMaxParallel(1)` survives a return to `normal`; `recheck()` wakes every waiter and `waitForSlot()` re-checks in a loop, resolving `"go"` or `"stop"`. `"stop"` = `stopAtCritical(level, activeCount)` confirmed by `sampler.fresh()`, so one stale sample cannot end a wave. Unstarted issues stay `pending` with `failureReason: "memory-critical"`, `stopStage: "launch"`; both retry paths refuse to spawn when `fresh()` reads `critical` (issue `failed`, `stopStage: "retry"`), and a `PostCheckResult.stopped`, from the first check or a re-check after a retry, is never retried (`stopStage: "post-check"`). The marker is cleared (`NO_STOP`) when `prepareIssues` takes an issue up (every issue not skipped as already `succeeded`, so a skip, worktree failure or cutover hold never inherits it) and again on launch/retry/check, and `reportHeldGates` ignores marked rows. `--no-adaptive` (`RunOptions.adaptive: false`) drops `warning` adaptation and hysteresis only; capacity is still 0 at `critical`. The user's override is `CO_PRESSURE_OVERRIDE=critical-as-warning`, applied inside the sampler. **Known gaps**: `onMergeConflict`'s synchronous `claude -p` (under `after-wave` merging) and mode-node commands still start at `critical`; neither runs in ship-dag's engine use. Mode-node commands no longer block the event loop: they run through `Deps.runCommandAsync` (`runShellAsync` in `yaml-hooks.ts`: with a `timeoutMs` the shell runs in its own process group, which gets SIGTERM at the timeout and SIGKILL 5 s later, and the promise rejects at the timeout; since Ctrl-C no longer reaches that group, `stopLiveCommandGroups` SIGKILLs every live one synchronously on the process's `exit` event (exit is final: the grace timer dies with the engine, so a member that traps TERM must not outlive it; a pgid, with its pending grace SIGKILL, leaves the live set only once `kill(-pgid, 0)` says no member is left (ESRCH; EPERM counts as alive), probed at the child's `exit` and `close` and, while a member lives, re-checked every 250 ms on an unref'd timer, so a member that traps TERM with its output redirected, which holds no pipe and so lets `close` fire at once, still gets the grace SIGKILL and the exit-time SIGKILL); a bounded command is unattended: `detached` means `setsid`, so it has no controlling terminal (interactive sudo/ssh/git credential prompts fail at once), and it is not reached by signals sent to the engine's process group (a group SIGKILL, a lease `suspend`'s SIGSTOP); mode-node commands are not lease holders; a `timeoutMs` above `MAX_TIMER_MS` (2^31−1, where `setTimeout` overflows) is no bound; the exit code rides on the error as `status`, so `describeCommandFailure` is unchanged), so a heartbeat-only holder (the session slots of #175) keeps beating during one. The engine's other synchronous calls are bounded so a blocking stretch stays within 60 s (the lease reaps 90 s after the last beat, and beats are 30 s apart): `verifyPrIdentity` and `producedNoCommits` pass `SYNC_CALL_TIMEOUT_MS` (10 s; a blocking stretch can begin 30 s after the last beat so it must end within 60 s, and verification's up to 5 calls plus the commit count make 6) to `Deps.runCommand`, and `worktree-hooks.ts`'s `defaultRunGit` has a 12 s `GIT_TIMEOUT_MS` per call (`setUpWorktree` makes up to four back to back: rev-parse, prune, `worktree add -b`, and the fallback `worktree add <path> <branch>`, so 48 s). `Deps.runCommandAsync` is optional: absent, mode-node commands fall back to the blocking `runCommand`. Still synchronous and unbounded: `onMergeConflict`'s `claude -p`, `merge.ts`'s gh/git calls, label sync's `gh` call (`yaml-hooks.ts`, on every `setStatus` when `labelSync` is configured, so it adds to the stretch after `producedNoCommits`), and the collision check's `git fetch origin` inside `postSessionCheck`.
- **Post-session check lease**: `Deps.lease` (`LeaseOptions`; set only by `createRealDeps` for the dispatch modes, from the same `defaultLeaseOptions(process.env, { warn: consoleLogger.warn })` call that supplies `memoryPressure`, so `deps.lease.level === deps.memoryPressure`; absent means unleased, no lease I/O) reaches `OrchestratorHooks.postSessionCheck` as `ctx: { lease, runningSessions }`. The derived check (`yaml-hooks.ts`) acquires one slot before its command loop (label `post-check <ref>`), passes `handle.childEnv()` and `handle.setChildPid` through `runCommand(cmd, cwd, env, onSpawn)`, and releases in `finally`. It waits with no time cap, logging on the first poll and then at most once a minute (throttled on the lease's `waitedMs`), and applies the stop rule through `stopWhen: stopAtCritical(level, live + runningSessions())`; a confirmed stop skips the commands but still runs the collision scan, and returns `stopped: "memory-critical"` (never retried). `runningSessions` is the engine's own `liveSessions` counter, incremented and decremented only in `spawnSession` (the exit reaction runs first, on both resolve and reject), never the pool's `activeCount`, which includes the waiting check's own slot.
- **Clocks**: in-process durations (e.g. the capacity governor's 60 s hysteresis) use monotonic time (`performance.now()`). Timestamps other processes read use wall-clock time, with the freshness rule chosen per timestamp: `level.json`'s `at` uses `isFresh` (a reading from the future is not fresh, and a reading that is not fresh falls back to `critical`, which can only stop work), while the mutex and holder heartbeat mtimes and holder `startedAt` use the symmetric `isWithinWindow` / `Math.abs` rule (a small step either way must not reap a live holder). A detached holder's `expiresAt` uses a one-sided rule on `LeaseOptions.now`: expired once `now() >= expiresAt` (a forward step frees the slot early, a backward one keeps it longer, still bounded by the session PID's liveness), and also expired when it is more than 750 s ahead (the 660 s `DETACHED_TTL_MAX_MS` cap a writer may set, plus the 90 s heartbeat window so a small backward step never reaps a holder written within the cap), matching the orphan bound's treatment of a far-future `startedAt`. Known exceptions, in-process timers still on the wall clock — don't copy them: the lease's wait timers (`waitedMs`, the 30 s busy fail-open, `maxWaitMs`, on `LeaseOptions.now`; `onWait` receives `waitedMs`, so the CLI's and the post-check's progress throttles run on it), the counter store's lock spin timeout, and the sampler's `cachedPressureSampler` TTL and in-process last-good fallback age (both guarded by `isFresh`, which treats a reading dated in the future as expired, so the cache re-reads and the fallback reads `critical`; a backward step smaller than a reading's age still stretches its life by the size of the step, at most one window). Reported durations (a release event's `heldMs`, a run record's `durationSeconds`) are differences of wall-clock timestamps and stay on the wall clock on purpose.
- **Config validation**: Zod schema in `validateConfig()` with cycle detection
- **YAML configs**: Alternative to pure-TS configs — `loadYamlConfig()` reads
  a YAML file, validates it, derives convention-based hooks, and merges
  optional `.hooks.ts` overrides. `setUpWorktree`/`removeWorktree` must be
  provided via overrides (no universal default).
- **Status change hooks**: `onStatusChange` hook in `OrchestratorHooks` is called on every status transition via `setStatus()`. Used by label sync. Errors are non-fatal.
- **CI retry**: When `retryOnCheckFailure` is configured, failed `postSessionCheck` results trigger automatic re-runs with failure context injected into the prompt.
- **Session stop line (`orchestrator-stop: lease-wait`)**: part of the engine's session contract. An agent that gives up after repeated heavy-command lease denials ends its final message with the exact whole line `orchestrator-stop: lease-wait`. After each session exits 0 (first attempt, 0-byte retry, check-failure retry) the engine reads the session log once and takes the last `type: "result"` record after the last `type: "system"`, `subtype: "init"` record (the start of the run that just exited; with no result after it there is no stop), skipping records tagged `hook_event_name` or `hook_event` (`lastSessionResult` in `engine.ts`; a check-failure retry appends to the log that holds the earlier attempt, so only the last record is the retry's own). If its `result` text has the line, `sessionStopped` skips the post-session check and any retry and calls `markStopped(issue, "session", "failed", "lease-wait")`, so a session with commits and a green check still ends `failed`. The reads sit at the call sites, not in `spawnSession`'s exit reaction, because they change control flow. Any other `orchestrator-stop: <reason>` is ignored with one warning, and the line anywhere else in the transcript does nothing. A PR the session opened first is still recorded.
- **Hook event auditing**: `--include-hook-events` is passed by default so PreToolUse/PostToolUse hook decisions appear in the stream-json log for post-session analysis.
- **Sequential-file collision detection**: When `sequentialPaths` is configured, `postSessionCheck` scans peer worktrees and `origin/<baseBranch>` for files added with the same captured key (e.g. Drizzle migration `NNNN_*.sql`) and fails the session on overlap. Failure context names the colliding peer/file and a suggested next-safe number, suitable for `retryOnCheckFailure` injection.
- **Journal-aware merge driver**: When `appendableFiles` is configured, the `claude-orchestrator-merge-appendable` CLI can be wired as a git merge driver via `.gitattributes`. It merges append-only JSON arrays by a `keyField` (e.g. Drizzle `_journal.json` by `idx`), eliminating manual conflict resolution after parallel migrations. Supports git driver mode (`--base %O --current %A --incoming %B`) and manual post-conflict mode (`--resolve <file>`).
- **Sequential-number coordination (`claimSequentialNumber`)**: When `sequentialDomains` is configured, the orchestrator exposes a `{{CLAIM_NUMBER}}` prompt variable that resolves to a partial CLI command (`node cli-claim.js --config <yaml> --issue <n> --domain`). Agents append a domain name and invoke the helper to receive a guaranteed-unique zero-padded number. State persists to `<configDir>/counters/<domain>.json` with a lockfile for cross-process safety. Claims are idempotent per `(domain, issueNumber)` so retries reuse the same number. First claim per domain seeds from `origin/<baseBranch>`. Composes with `sequentialPaths` (claim is primary synchronization, detection is the backstop).

### YAML Config Fields

```yaml
name: "project-name"
configDir: ".orchestrator/config"
worktreeDir: ".worktrees"
projectRoot: "."
stallTimeout: 600
promptTemplate: "prompt.md"
branchPrefix: "orchestrator/"

# Repo assigned to issues that don't declare their own `repo`, used to build each
# issue's composite ref ("owner/repo#N"). When unset, repo-less issues key on
# their bare number "N" (single-repo back-compat; on-disk state filenames and
# numeric ordering are unchanged).
defaultRepo: "owner/repo"

# Post-session validation commands
postSessionCheck:
  commands: ["npm test", "npm run typecheck"]
  cwd: "."  # optional, relative to worktree

# Auto-retry on check failure
retryOnCheckFailure:
  maxRetries: 2
  enabled: true  # defaults to true if omitted

# Post run summary comments on GitHub issues
issueComments:
  repo: "owner/repo"
  enabled: true  # defaults to true if omitted

# Sync status labels on GitHub issues
labelSync:
  prefix: "orchestrator"
  repo: "owner/repo"  # optional, falls back to issue-level repo

# Base branch used for collision-detection diffs and counter seeding (default "main")
baseBranch: "main"

# Default model/effort for the per-issue policy (model-effort.ts). Baseline is
# Sonnet; effort defaults to medium (or the per-issue complexity tier). Retries
# escalate effort one tier per attempt (cap max); Haiku at high+ effort is
# promoted to Sonnet. Per-issue model/effort/complexity override these.
defaultModel: "sonnet"
defaultEffort: "medium"

# Per-repo overrides for cross-repo DAGs, keyed by owner/repo. Each entry may
# override baseBranch, postSessionCheck, sequentialPaths, appendableFiles for
# issues that declare (or inherit via defaultRepo) that repo. Replace semantics,
# not deep-merge; an omitted field inherits the top-level value. A key not
# referenced by any issue/defaultRepo is a hard load error (typo guard).
repos:
  "WXYC/wxyc-ios-64":
    baseBranch: "master"                       # iOS forks from master, not main
    postSessionCheck:
      commands: ["xcodebuild test -scheme WXYC"]
  "WXYC/library-metadata-lookup":
    postSessionCheck:
      commands: ["ruff check .", "pytest -q"]

# Detect sequentially-numbered-file collisions across peer worktrees during postSessionCheck
sequentialPaths:
  - dir: "shared/database/src/migrations"
    pattern: "(\\d{4})_.*\\.sql"  # group 1 is the unique key

# Coordination domains for guaranteed-unique numbering (issue #25). When set,
# {{CLAIM_NUMBER}} is exposed as a prompt template variable.
sequentialDomains:
  migrations:
    paths:
      - dir: "shared/database/src/migrations"
        pattern: "(\\d{4})_.*\\.sql"
    width: 4

# Append-style JSON array files wired to the journal-aware merge driver (issue #37).
# Prevents merge conflicts on files like Drizzle's _journal.json.
appendableFiles:
  - path: "shared/database/src/migrations/meta/_journal.json"
    format: "json-array"
    arrayPath: "entries"
    keyField: "idx"

# Files safe to overlap across parallel issues (ownsFiles allowlist).
# appendableFiles paths are automatically exempt; list others here.
sharedFiles:
  - "package-lock.json"
  - "tests/mocks/database.mock.ts"

# Template variables: {{ISSUE_NUMBER}}, {{SLUG}}, {{DESCRIPTION}},
# {{projectRoot}}, {{configDir}}, {{worktreeDir}}, {{UPSTREAM_CONTEXT}},
# {{CLAIM_NUMBER}} (only when sequentialDomains is configured)

issues:
  - number: 1
    slug: feature-name
    dependsOn: []
    # repo: "owner/repo"  # optional; overrides defaultRepo for this issue's ref
    description: "Feature description"
    # model: opus         # optional; alias (haiku/sonnet/opus) or full id; overrides defaultModel
    # effort: high        # optional; low|medium|high|xhigh|max; overrides the complexity tier
    # complexity: complex # optional; mechanical→low, normal→medium, complex→high (sets default effort)
    # extraDirs: ["../wxyc-shared"]  # optional; extra read-only dirs (--add-dir); relative to config file
    # serial: true  # optional; runs this issue alone in its own wave (e.g. for migrations)
    # ownsFiles:    # optional; files this issue expects to write (triggers wave serialization on overlap)
  # dependsOn entries are a bare number/numeric-string (same repo as this issue)
  # or a fully-qualified cross-repo ref "owner/repo#N":
  #   dependsOn: [1, "WXYC/other-repo#2"]
  # A mode-node (mode-node.ts) runs a command instead of a Claude session — no
  # worktree/model/effort. mode is deploy|publish|gate. With a command it runs it
  # (exit 0 → succeeded, non-zero → failed); WITHOUT a command it's a manual gate
  # that holds for a confirmCutover hook. Skipped by the merge step (no PR).
  # - number: 2
  #   slug: deploy-lml
  #   mode: deploy
  #   command: "gh workflow run deploy.yml -R WXYC/library-metadata-lookup"
  #   dependsOn: [1]
```

A **cutover gate** stops the engine before releasing an issue behind a command-less manual gate or a bare cross-repo dependency (a dep in another repo that isn't itself a mode-node — a command node's exit-0 or a manual gate's own confirmation already counts as the cutover). Confirmation comes from an optional `confirmCutover(issue, reason)` hook; when it's absent, gated issues **hold** (left `pending`, dependents skip) — a cross-repo run wires `confirmCutover` or uses command mode-nodes to progress unattended. See `cutoverReason` in `mode-node.ts`.

### Wave-plan preview (`--plan`)

Before committing compute to a cross-repo run, `--plan` prints — read-only, no worktrees, no dispatch — the exact wave partition the engine would execute: each issue grouped under its wave by composite ref (so colliding numbers across repos stay distinct), its resolved model/effort or mode-node kind + command, its dependencies, and a trailing list of the HITL cutover gates where the run will hold. It's the acceptance check for a new config: confirm the waves and gates read correctly before you run it for real. Rendered by the pure `renderPlanPreview(config)` (`plan-preview.ts`). The model/effort shown is the per-issue + config-default policy; it does not reflect a config that pins the model via generic `claudeArgs`/`getClaudeArgs` (which the engine applies last).

### CLI Modes

```bash
<script> <config> [options]
  --help, -h         Show help
  --status           Show current issue statuses
  --plan             Preview the wave partition without running (read-only)
  --watch            Live terminal dashboard
  --dashboard        Web dashboard (HTTP + SSE)
  --port <n>         Port for web dashboard (default: 3000)
  --merge            Merge succeeded PRs
  --cleanup          Remove worktrees and branches
  --retry-failed     Retry failed issues
  --tail             Reattach to detached run
  --decompose        LLM-driven task decomposition
  --file <path>      Input file for decompose
  --issue <n>        GitHub issue number for decompose
  --repo <owner/repo>  Repository for decompose/issue creation
  --create-issues    Create GitHub issues from decompose output
  --wave <n>         Run specific wave
  --parallel <n>     Max parallel sessions (default: 4)
  --no-adaptive      Skip warning adaptation and the 60 s hysteresis (critical still stops launches and retries)
  --merge-after-wave Merge PRs after each wave
  --detach           Run in background
  --notify           macOS notification on completion
```

### Commands

```bash
npm test           # Run tests
npm run typecheck  # Type-check
npm run build      # Build to dist/
```

### Self-hosted orchestration

This repo orchestrates work on its own open issues via `.orchestrator/`. See `.orchestrator/README.md` for the per-wave workflow.

```bash
npm run orchestrate           # Run a wave (configure issues in .orchestrator/config.yaml first)
npm run orchestrate:status    # Show current issue statuses
npm run orchestrate:dashboard # HTTP dashboard at :3000
npm run orchestrate:cleanup   # Remove worktrees and branches
```

`.orchestrator/run.ts` imports the orchestrator core from `dist/`, so `npm run build` must be up-to-date before running.
