import { describe, it, expect, vi } from "vitest";
import { mergePrs, type MergeDeps } from "../src/merge.js";
import type { Issue, IssueMetadata, Status } from "../src/types.js";

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

function makeMergeDeps(overrides: Partial<MergeDeps> = {}): MergeDeps {
  return {
    getStatus: vi.fn(() => "succeeded" as Status),
    getMetadata: vi.fn(() => ({
      prUrl: "https://github.com/org/repo/pull/1",
      prNumber: 1,
    })),
    runCommand: vi.fn(() => ""),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      step: vi.fn(),
      header: vi.fn(),
    },
    ...overrides,
  };
}

describe("mergePrs", () => {
  it("merges PR for succeeded issue with PR URL", async () => {
    const issue = makeIssue({ number: 1 });
    const deps = makeMergeDeps();
    const results = await mergePrs([issue], deps);

    expect(results.get(1)).toBe("merged");
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh pr merge https://github.com/org/repo/pull/1 --rebase",
    );
  });

  it("uses --admin flag when admin option is true", async () => {
    const issue = makeIssue({ number: 1 });
    const deps = makeMergeDeps();
    const results = await mergePrs([issue], deps, { admin: true });

    expect(results.get(1)).toBe("merged");
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh pr merge https://github.com/org/repo/pull/1 --rebase --admin",
    );
  });

  it("skips issues that are not succeeded", async () => {
    const issue = makeIssue({ number: 1 });
    const deps = makeMergeDeps({
      getStatus: vi.fn(() => "failed" as Status),
    });
    const results = await mergePrs([issue], deps);

    expect(results.get(1)).toBe("skipped");
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("skips issues with no PR URL in metadata", async () => {
    const issue = makeIssue({ number: 1 });
    const deps = makeMergeDeps({
      getMetadata: vi.fn(() => ({} as IssueMetadata)),
    });
    const results = await mergePrs([issue], deps);

    expect(results.get(1)).toBe("skipped");
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("records failed when gh command throws", async () => {
    const issue = makeIssue({ number: 1 });
    const deps = makeMergeDeps({
      runCommand: vi.fn(() => {
        throw new Error("merge conflict");
      }),
    });
    const results = await mergePrs([issue], deps);

    expect(results.get(1)).toBe("failed");
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("merge conflict"),
    );
  });

  it("processes issues in wave order", async () => {
    const issues = [
      makeIssue({ number: 3, wave: 3 }),
      makeIssue({ number: 1, wave: 1 }),
      makeIssue({ number: 2, wave: 2 }),
    ];
    const mergeOrder: number[] = [];
    const deps = makeMergeDeps({
      getMetadata: vi.fn((n: number) => ({
        prUrl: `https://github.com/org/repo/pull/${n}`,
        prNumber: n,
      })),
      runCommand: vi.fn((cmd: string) => {
        const match = cmd.match(/pull\/(\d+)/);
        if (match) mergeOrder.push(parseInt(match[1], 10));
        return "";
      }),
    });

    await mergePrs(issues, deps);

    expect(mergeOrder).toEqual([1, 2, 3]);
  });

  it("handles mix of statuses correctly", async () => {
    const issues = [
      makeIssue({ number: 1, wave: 1 }),
      makeIssue({ number: 2, wave: 1 }),
      makeIssue({ number: 3, wave: 1 }),
    ];
    const statusMap: Record<number, Status> = {
      1: "succeeded",
      2: "failed",
      3: "succeeded",
    };
    const metadataMap: Record<number, IssueMetadata> = {
      1: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
      2: { prUrl: "https://github.com/org/repo/pull/2", prNumber: 2 },
      3: {},
    };
    const deps = makeMergeDeps({
      getStatus: vi.fn((n: number) => statusMap[n] ?? "pending"),
      getMetadata: vi.fn((n: number) => metadataMap[n] ?? {}),
    });

    const results = await mergePrs(issues, deps);

    expect(results.get(1)).toBe("merged");
    expect(results.get(2)).toBe("skipped"); // failed status
    expect(results.get(3)).toBe("skipped"); // no PR URL
  });

  describe("onMergeConflict hook", () => {
    it("invokes the hook when merge fails with a conflict error", async () => {
      const issue = makeIssue({ number: 1 });
      const onMergeConflict = vi.fn().mockResolvedValue({ resolved: false });
      const deps = makeMergeDeps({
        runCommand: vi.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("gh pr merge")) throw new Error("GraphQL: Merge conflict");
          return "";
        }),
        onMergeConflict,
      });

      const results = await mergePrs([issue], deps);

      expect(results.get(1)).toBe("failed");
      expect(onMergeConflict).toHaveBeenCalledWith(issue, expect.any(Array), "main");
    });

    it("retries the merge when the hook returns resolved:true", async () => {
      const issue = makeIssue({ number: 1 });
      let mergeCallCount = 0;
      const onMergeConflict = vi.fn().mockResolvedValue({ resolved: true });
      const deps = makeMergeDeps({
        runCommand: vi.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("gh pr merge")) {
            mergeCallCount++;
            if (mergeCallCount === 1) throw new Error("GraphQL: Merge conflict");
          }
          return "";
        }),
        onMergeConflict,
      });

      const results = await mergePrs([issue], deps);

      expect(results.get(1)).toBe("merged");
      expect(mergeCallCount).toBe(2);
    });

    it("marks failed when retry also fails after hook resolves", async () => {
      const issue = makeIssue({ number: 1 });
      const onMergeConflict = vi.fn().mockResolvedValue({ resolved: true });
      const deps = makeMergeDeps({
        runCommand: vi.fn().mockImplementation((cmd: string) => {
          if (cmd.includes("gh pr merge")) throw new Error("GraphQL: Merge conflict");
          return "";
        }),
        onMergeConflict,
      });

      const results = await mergePrs([issue], deps);

      expect(results.get(1)).toBe("failed");
      expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("#1"));
    });

    it("does not invoke the hook when merge fails with a non-conflict error", async () => {
      const issue = makeIssue({ number: 1 });
      const onMergeConflict = vi.fn();
      const deps = makeMergeDeps({
        runCommand: vi.fn(() => { throw new Error("network timeout"); }),
        onMergeConflict,
      });

      const results = await mergePrs([issue], deps);

      expect(results.get(1)).toBe("failed");
      expect(onMergeConflict).not.toHaveBeenCalled();
    });

    it("does not invoke the hook when onMergeConflict is not defined", async () => {
      const issue = makeIssue({ number: 1 });
      const deps = makeMergeDeps({
        runCommand: vi.fn(() => { throw new Error("GraphQL: Merge conflict"); }),
      });

      const results = await mergePrs([issue], deps);

      expect(results.get(1)).toBe("failed");
    });

    it("passes baseBranch from deps to the hook", async () => {
      const issue = makeIssue({ number: 1 });
      const onMergeConflict = vi.fn().mockResolvedValue({ resolved: false });
      const deps = makeMergeDeps({
        runCommand: vi.fn(() => { throw new Error("Merge conflict"); }),
        onMergeConflict,
        baseBranch: "develop",
      });

      await mergePrs([issue], deps);

      expect(onMergeConflict).toHaveBeenCalledWith(issue, expect.any(Array), "develop");
    });

    it("continues to mark failed when hook itself throws", async () => {
      const issue = makeIssue({ number: 1 });
      const onMergeConflict = vi.fn().mockRejectedValue(new Error("hook exploded"));
      const deps = makeMergeDeps({
        runCommand: vi.fn(() => { throw new Error("GraphQL: Merge conflict"); }),
        onMergeConflict,
      });

      const results = await mergePrs([issue], deps);

      expect(results.get(1)).toBe("failed");
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("hook exploded"));
    });
  });

  describe("intra-wave rebase", () => {
    it("rebases remaining PRs after merging first", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
      ];
      const metadataMap: Record<number, IssueMetadata> = {
        1: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
        2: { prUrl: "https://github.com/org/repo/pull/2", prNumber: 2 },
      };
      const worktreeMap: Record<number, string> = {
        1: "/worktrees/issue-1",
        2: "/worktrees/issue-2",
      };
      const commands: string[] = [];
      const deps = makeMergeDeps({
        getMetadata: vi.fn((n: number) => metadataMap[n] ?? {}),
        runCommand: vi.fn((cmd: string) => {
          commands.push(cmd);
          return "";
        }),
        getWorktreePath: vi.fn((issue: Issue) => worktreeMap[issue.number]),
      });

      const results = await mergePrs(issues, deps);

      expect(results.get(1)).toBe("merged");
      expect(results.get(2)).toBe("merged");

      // After merging #1, should rebase #2 before merging it
      const mergeIdx1 = commands.findIndex((c) => c.includes("pull/1"));
      const fetchIdx = commands.findIndex((c) => c.includes('git -C "/worktrees/issue-2" fetch origin main'));
      const rebaseIdx = commands.findIndex((c) => c.includes('git -C "/worktrees/issue-2" rebase origin/main'));
      const pushIdx = commands.findIndex((c) => c.includes('git -C "/worktrees/issue-2" push --force-with-lease'));
      const mergeIdx2 = commands.findIndex((c) => c.includes("pull/2"));

      expect(fetchIdx).toBeGreaterThan(mergeIdx1);
      expect(rebaseIdx).toBeGreaterThan(fetchIdx);
      expect(pushIdx).toBeGreaterThan(rebaseIdx);
      expect(mergeIdx2).toBeGreaterThan(pushIdx);
    });

    it("marks rebase-failed and calls rebase --abort on failure", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
        makeIssue({ number: 3, wave: 1 }),
      ];
      const metadataMap: Record<number, IssueMetadata> = {
        1: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
        2: { prUrl: "https://github.com/org/repo/pull/2", prNumber: 2 },
        3: { prUrl: "https://github.com/org/repo/pull/3", prNumber: 3 },
      };
      const worktreeMap: Record<number, string> = {
        1: "/worktrees/issue-1",
        2: "/worktrees/issue-2",
        3: "/worktrees/issue-3",
      };
      const commands: string[] = [];
      const deps = makeMergeDeps({
        getMetadata: vi.fn((n: number) => metadataMap[n] ?? {}),
        runCommand: vi.fn((cmd: string) => {
          commands.push(cmd);
          // Rebase fails for issue-2
          if (cmd.includes('git -C "/worktrees/issue-2" rebase origin/main')) {
            throw new Error("conflict");
          }
          return "";
        }),
        getWorktreePath: vi.fn((issue: Issue) => worktreeMap[issue.number]),
      });

      const results = await mergePrs(issues, deps);

      expect(results.get(1)).toBe("merged");
      expect(results.get(2)).toBe("rebase-failed");
      expect(results.get(3)).toBe("merged"); // Still tries #3

      // Verify rebase --abort was called for issue-2
      expect(commands).toContain('git -C "/worktrees/issue-2" rebase --abort');
    });

    it("does not rebase when getWorktreePath is absent", async () => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
      ];
      const metadataMap: Record<number, IssueMetadata> = {
        1: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
        2: { prUrl: "https://github.com/org/repo/pull/2", prNumber: 2 },
      };
      const commands: string[] = [];
      const deps = makeMergeDeps({
        getMetadata: vi.fn((n: number) => metadataMap[n] ?? {}),
        runCommand: vi.fn((cmd: string) => {
          commands.push(cmd);
          return "";
        }),
        // No getWorktreePath
      });

      const results = await mergePrs(issues, deps);

      expect(results.get(1)).toBe("merged");
      expect(results.get(2)).toBe("merged");

      // Only gh pr merge commands, no git commands
      const gitCommands = commands.filter((c) => c.startsWith("git "));
      expect(gitCommands).toHaveLength(0);
    });

    it.each([
      { label: "non-succeeded status", status: "failed" as Status, prUrl: "https://github.com/org/repo/pull/2" },
      { label: "no PR URL", status: "succeeded" as Status, prUrl: undefined },
    ])("does not rebase ineligible issues ($label)", async ({ status, prUrl }) => {
      const issues = [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 1 }),
      ];
      const statusMap: Record<number, Status> = { 1: "succeeded", 2: status };
      const metadataMap: Record<number, IssueMetadata> = {
        1: { prUrl: "https://github.com/org/repo/pull/1", prNumber: 1 },
        2: { prUrl, prNumber: prUrl ? 2 : undefined },
      };
      const commands: string[] = [];
      const deps = makeMergeDeps({
        getStatus: vi.fn((n: number) => statusMap[n] ?? "pending"),
        getMetadata: vi.fn((n: number) => metadataMap[n] ?? {}),
        runCommand: vi.fn((cmd: string) => {
          commands.push(cmd);
          return "";
        }),
        getWorktreePath: vi.fn((issue: Issue) => `/worktrees/issue-${issue.number}`),
      });

      await mergePrs(issues, deps);

      // No git rebase commands for issue #2
      const rebaseCommands = commands.filter((c) => c.includes("issue-2") && c.includes("rebase"));
      expect(rebaseCommands).toHaveLength(0);
    });

    it("returns empty map for empty issues array", async () => {
      const deps = makeMergeDeps();
      const results = await mergePrs([], deps);

      expect(results.size).toBe(0);
      expect(deps.runCommand).not.toHaveBeenCalled();
    });
  });
});
