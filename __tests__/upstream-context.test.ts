import { describe, it, expect, vi } from "vitest";
import {
  gatherUpstreamContext,
  type UpstreamContextDeps,
} from "../src/upstream-context.js";
import type { Issue } from "../src/types.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    slug: "test-issue",
    wave: 1,
    deps: [],
    dependsOn: [],
    description: "Test issue",
    ...overrides,
  };
}

describe("gatherUpstreamContext", () => {
  it("returns empty string when issue has no dependencies", () => {
    const issue = makeIssue({ deps: [] });
    const deps: UpstreamContextDeps = {
      readFile: vi.fn(),
      getWorktreePath: vi.fn(),
    };

    const result = gatherUpstreamContext(issue, [], deps);
    expect(result).toBe("");
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("reads HANDOFF.md from a single dependency worktree", () => {
    const dep = makeIssue({ number: 1, slug: "dep-issue" });
    const issue = makeIssue({ number: 2, deps: [1] });

    const deps: UpstreamContextDeps = {
      readFile: vi.fn(() => "Built the auth module.\nKey: JWT tokens."),
      getWorktreePath: vi.fn(() => "/worktrees/dep-issue"),
    };

    const result = gatherUpstreamContext(issue, [dep, issue], deps);
    expect(deps.getWorktreePath).toHaveBeenCalledWith(dep);
    expect(deps.readFile).toHaveBeenCalledWith("/worktrees/dep-issue/HANDOFF.md");
    expect(result).toContain("## Upstream: #1 (dep-issue)");
    expect(result).toContain("Built the auth module.");
  });

  it("concatenates context from multiple dependencies", () => {
    const dep1 = makeIssue({ number: 1, slug: "auth" });
    const dep2 = makeIssue({ number: 3, slug: "db" });
    const issue = makeIssue({ number: 5, deps: [1, 3] });

    const deps: UpstreamContextDeps = {
      readFile: vi.fn((path: string) => {
        if (path.includes("auth")) return "Auth context";
        if (path.includes("db")) return "DB context";
        return "";
      }),
      getWorktreePath: vi.fn((i: Issue) => `/worktrees/${i.slug}`),
    };

    const result = gatherUpstreamContext(issue, [dep1, dep2, issue], deps);
    expect(result).toContain("## Upstream: #1 (auth)");
    expect(result).toContain("Auth context");
    expect(result).toContain("## Upstream: #3 (db)");
    expect(result).toContain("DB context");
  });

  it("silently skips dependencies with missing HANDOFF.md", () => {
    const dep = makeIssue({ number: 1, slug: "dep-issue" });
    const issue = makeIssue({ number: 2, deps: [1] });

    const deps: UpstreamContextDeps = {
      readFile: vi.fn(() => { throw new Error("ENOENT: no such file"); }),
      getWorktreePath: vi.fn(() => "/worktrees/dep-issue"),
    };

    const result = gatherUpstreamContext(issue, [dep, issue], deps);
    expect(result).toBe("");
  });

  it("skips dependencies not found in allIssues", () => {
    const issue = makeIssue({ number: 2, deps: [999] });

    const deps: UpstreamContextDeps = {
      readFile: vi.fn(),
      getWorktreePath: vi.fn(),
    };

    const result = gatherUpstreamContext(issue, [issue], deps);
    expect(result).toBe("");
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("includes context from some deps and skips missing ones", () => {
    const dep1 = makeIssue({ number: 1, slug: "present" });
    const dep2 = makeIssue({ number: 3, slug: "missing" });
    const issue = makeIssue({ number: 5, deps: [1, 3] });

    const deps: UpstreamContextDeps = {
      readFile: vi.fn((path: string) => {
        if (path.includes("present")) return "Present context";
        throw new Error("ENOENT");
      }),
      getWorktreePath: vi.fn((i: Issue) => `/worktrees/${i.slug}`),
    };

    const result = gatherUpstreamContext(issue, [dep1, dep2, issue], deps);
    expect(result).toContain("## Upstream: #1 (present)");
    expect(result).toContain("Present context");
    expect(result).not.toContain("missing");
  });
});
