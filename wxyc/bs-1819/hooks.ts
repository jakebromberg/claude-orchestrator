// hooks.ts — cross-repo worktree + cutover wiring for the BS#1819 config.
//
// Worktree lifecycle comes from the reusable deriveWorktreeHooks (A2): for each
// issue it locates the repo's checkout under ~/Developer/WXYC, forks a branch off
// that repo's OWN base branch (derived from origin/HEAD — so wxyc-ios-64's
// `master` is honored, not assumed `main`), and creates the worktree in the
// sibling <repo>-worktrees/ directory. Per-repo CI and the merge-step base branch
// come from the `repos:` map in config.yaml (wired by the YAML hook layer).
//
// confirmCutover is the human-in-the-loop gate. The run holds at the wait-canary
// manual gate (and at any bare cross-repo hand-off) until this returns true —
// left absent, gated issues hold forever. Unattended runs opt in with
// AUTO_CONFIRM_CUTOVER=1 once a human has verified the canary out of band.

import { createInterface } from "node:readline/promises";
import { deriveWorktreeHooks } from "../../dist/src/index.js";
import type { HooksOverride } from "../../dist/src/yaml-types.js";
import type { Issue } from "../../dist/src/types.js";

const worktree = deriveWorktreeHooks(); // ~/Developer/WXYC, per-repo base from origin/HEAD

const hooksOverride: HooksOverride = {
  ...worktree,

  async confirmCutover(issue: Issue, reason: string): Promise<boolean> {
    if (process.env.AUTO_CONFIRM_CUTOVER === "1") return true;
    // No tty to prompt on (e.g. a --detach run) → hold; a later interactive
    // `run-all` re-evaluates the gate and can approve it.
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `\nCutover gate — ${issue.ref} (${issue.slug}): ${reason}\n` +
          `Release this issue and its dependents? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  },
};

export default hooksOverride;
