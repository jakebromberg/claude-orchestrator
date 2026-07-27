import { execSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { HooksOverride } from "../../src/yaml-types.js";

const WXYC_ROOT = resolve(process.env.HOME!, "Developer/WXYC");

const REPO_MAP: Record<string, string> = {
  "xml-converter-videos": "discogs-xml-converter",
  "cache-video-import": "discogs-cache",
  "lml-video-support": "library-metadata-lookup",
};

function getWorktreePath(slug: string): string {
  return resolve("./worktrees/discogs-video", slug);
}

function getBranchName(slug: string): string {
  return `feature/discogs-video-${slug}`;
}

const hooksOverride: HooksOverride = {
  getWorktreePath(issue) {
    return getWorktreePath(issue.slug);
  },

  getBranchName(issue) {
    return getBranchName(issue.slug);
  },

  async setUpWorktree(issue) {
    const repoName = REPO_MAP[issue.slug];
    if (!repoName) {
      throw new Error(`Unknown issue slug: ${issue.slug}`);
    }

    const repoPath = resolve(WXYC_ROOT, repoName);
    const worktreePath = getWorktreePath(issue.slug);
    const branch = getBranchName(issue.slug);

    if (!existsSync(repoPath)) {
      throw new Error(`Repo not found: ${repoPath}`);
    }

    mkdirSync(resolve(worktreePath, ".."), { recursive: true });

    try {
      execSync(`git -C "${repoPath}" worktree add "${worktreePath}" -b "${branch}" main`, {
        stdio: "pipe",
      });
    } catch {
      // Branch may already exist — try checking it out
      try {
        execSync(`git -C "${repoPath}" worktree add "${worktreePath}" "${branch}"`, {
          stdio: "pipe",
        });
      } catch {
        // Worktree may already exist
        if (!existsSync(worktreePath)) {
          throw new Error(`Failed to create worktree at ${worktreePath}`);
        }
      }
    }
  },

  async removeWorktree(issue) {
    const repoName = REPO_MAP[issue.slug];
    if (!repoName) return;
    const repoPath = resolve(WXYC_ROOT, repoName);
    const worktreePath = getWorktreePath(issue.slug);

    if (existsSync(worktreePath)) {
      try {
        execSync(`git -C "${repoPath}" worktree remove "${worktreePath}" --force`, {
          stdio: "pipe",
        });
      } catch {
        // Best effort
      }
    }
  },
};

export default hooksOverride;
