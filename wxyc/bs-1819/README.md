# BS#1819 — cross-repo orchestrator config

The first real multi-repo config: the children of the [BS#1819](https://github.com/WXYC/Backend-Service/issues/1819) epic ("Protect local catalog search from LML enrichment degradation"), spanning three implementation repos plus two synthetic deploy-ordering nodes.

## Preview before running

```bash
npx tsx wxyc/bs-1819/run.ts bs-1819 --plan
```

`--plan` prints the wave partition read-only — no worktrees, no sessions. It is the acceptance check for this bundle: confirm the waves, the per-issue model/effort, and the single HITL cutover gate before committing compute.

## The DAG

| Wave | Nodes | Notes |
|---|---|---|
| 1 | LML #924, #926, #928, #930, #931 | independent lane-isolation work |
| 2 | LML #927 (←#924), #929 (←#926) | builds on wave 1 |
| 3 | `deploy-lml` (#9001, `mode: deploy`) | deploy LML once all its work is merged — command node, auto cutover on exit-0 |
| 4 | canary #82 (←deploy-lml) | verify isolation live in prod |
| 5 | `wait-canary` (#9002, `mode: gate`) | **manual HITL gate** — holds for `confirmCutover` |
| 6 | ios #685 (←wait-canary) | terminal consumer |

Three repos (`library-metadata-lookup`, `wxyc-canary`, `wxyc-ios-64`), each forking from its own base branch (iOS `master`, the rest `main`) and running its own CI. Every node keys on its composite ref, so numbers never collide across repos.

`#926` and `ios#685` are already CLOSED; they stay in the graph to preserve the topology (#929 consumes the #926 ADR; ios#685 is the terminal consumer). `#9001`/`#9002` are synthetic non-issue DAG nodes. Several LML issues are upstream-blocked by work outside this config's node set (BS#1826, LML#943, BS#1827) — noted in each `description`; do not add them as `dependsOn` (they are not nodes here).

## Files

| Path | Purpose |
|---|---|
| `config.yaml` | The DAG + per-repo CI/base-branch (`repos:` map) + per-issue model/effort. |
| `prompt.md` | Repo-agnostic prompt — the agent reads the worktree's repo `CLAUDE.md` for stack conventions. |
| `hooks.ts` | Wires `deriveWorktreeHooks` (A2) + `confirmCutover` (the manual-gate prompt). |
| `run.ts` | Entry point — loads `config.yaml`, imports the engine from the committed `dist/`. |
| `.orchestrator/` | Runtime state (gitignored). |

## Running it

```bash
npx tsx wxyc/bs-1819/run.ts bs-1819 --plan          # preview
npx tsx wxyc/bs-1819/run.ts bs-1819 --parallel 3    # run (holds at wait-canary)
AUTO_CONFIRM_CUTOVER=1 npx tsx wxyc/bs-1819/run.ts bs-1819   # auto-approve gates (canary already verified)
```

Prerequisites: `dist/` built at HEAD; all three repos cloned under `~/Developer/WXYC`; `gh` authenticated for the WXYC org. A `--detach` run holds at the manual gate (no tty to prompt) — resume it with an interactive `run-all`, not `--retry-failed` (a held gate is `pending`, not `failed`).
