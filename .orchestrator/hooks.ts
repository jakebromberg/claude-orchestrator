import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HooksOverride } from "../dist/src/yaml-types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

function getWorktreePath(slug: string): string {
  return resolve(REPO_ROOT, "worktrees", slug);
}

function getBranchName(slug: string): string {
  return `orchestrator/${slug}`;
}

const hooksOverride: HooksOverride = {
  getWorktreePath(issue) {
    return getWorktreePath(issue.slug);
  },

  getBranchName(issue) {
    return getBranchName(issue.slug);
  },

  async setUpWorktree(issue) {
    const worktreePath = getWorktreePath(issue.slug);
    const branch = getBranchName(issue.slug);

    mkdirSync(resolve(worktreePath, ".."), { recursive: true });

    if (!existsSync(worktreePath)) {
      try {
        execFileSync(
          "git",
          ["-C", REPO_ROOT, "worktree", "add", worktreePath, "-b", branch, "origin/main"],
          { stdio: "pipe" },
        );
      } catch {
        // Branch may already exist locally — try checking it out
        execFileSync(
          "git",
          ["-C", REPO_ROOT, "worktree", "add", worktreePath, branch],
          { stdio: "pipe" },
        );
      }
    }

    // Agent and postSessionCheck both need node_modules. `npm ci` is fast and
    // deterministic given the lockfile is at HEAD of main.
    execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefer-offline"], {
      cwd: worktreePath,
      stdio: "pipe",
    });
  },

  async removeWorktree(issue) {
    const worktreePath = getWorktreePath(issue.slug);
    if (existsSync(worktreePath)) {
      try {
        execFileSync(
          "git",
          ["-C", REPO_ROOT, "worktree", "remove", worktreePath, "--force"],
          { stdio: "pipe" },
        );
      } catch {
        // Best effort; operator can clean up manually if needed.
      }
    }
  },
};

export default hooksOverride;
