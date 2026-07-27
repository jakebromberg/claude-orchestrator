/**
 * Upstream context gathering module.
 *
 * Reads `HANDOFF.md` files from upstream dependency worktrees and
 * assembles them into a single context string for injection into
 * downstream agent prompts via `{{UPSTREAM_CONTEXT}}`.
 */

import type { Issue } from "./types.js";

/** Dependencies for upstream context gathering, injectable for testing. */
export interface UpstreamContextDeps {
  readFile: (path: string) => string;
  getWorktreePath: (issue: Issue) => string;
}

/**
 * Gather upstream context from dependency worktrees.
 *
 * For each dependency in `issue.deps`, looks up the corresponding issue
 * in `allIssues`, reads `HANDOFF.md` from its worktree, and concatenates
 * all found content with section headers.
 *
 * Missing files are silently skipped. Dependencies not found in
 * `allIssues` are also skipped.
 *
 * @returns Concatenated context string, or empty string if no context found.
 */
export function gatherUpstreamContext(
  issue: Issue,
  allIssues: Issue[],
  deps: UpstreamContextDeps,
): string {
  if (issue.deps.length === 0) return "";

  const sections: string[] = [];

  for (const depNumber of issue.deps) {
    const depIssue = allIssues.find((i) => i.number === depNumber);
    if (!depIssue) continue;

    const worktreePath = deps.getWorktreePath(depIssue);
    try {
      const content = deps.readFile(`${worktreePath}/HANDOFF.md`);
      sections.push(`## Upstream: #${depIssue.number} (${depIssue.slug})\n\n${content}`);
    } catch {
      // HANDOFF.md doesn't exist — skip silently
    }
  }

  return sections.join("\n\n");
}
