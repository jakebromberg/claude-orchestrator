import { describe, it, expect, vi } from "vitest";
import {
  postRunSummaryComments,
  type IssueCommentConfig,
  type IssueCommentDeps,
} from "../src/issue-comments.js";
import type { Issue, Status, IssueMetadata, Logger } from "../src/types.js";

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

function makeSilentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    header: vi.fn(),
  };
}

function makeDeps(overrides: Partial<IssueCommentDeps> = {}): IssueCommentDeps {
  return {
    runCommand: vi.fn(() => ""),
    getStatus: vi.fn(() => "succeeded" as Status),
    getMetadata: vi.fn(() => ({} as IssueMetadata)),
    logger: makeSilentLogger(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<IssueCommentConfig> = {}): IssueCommentConfig {
  return {
    repo: "owner/repo",
    runId: "2024-01-01T00-00-00.000Z",
    configName: "test-orchestrator",
    ...overrides,
  };
}

describe("postRunSummaryComments", () => {
  it("posts comment for succeeded issue", () => {
    const issues = [makeIssue({ number: 42 })];
    const deps = makeDeps({
      getStatus: vi.fn(() => "succeeded" as Status),
      getMetadata: vi.fn(() => ({
        prUrl: "https://github.com/owner/repo/pull/10",
        startedAt: "2024-01-01T00:00:00Z",
        finishedAt: "2024-01-01T00:05:00Z",
      })),
    });

    postRunSummaryComments(issues, makeConfig(), deps);

    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 42 --repo owner/repo --body-file -",
      expect.objectContaining({
        input: expect.stringContaining("succeeded"),
      }),
    );
  });

  it("includes PR link in comment body when available", () => {
    const issues = [makeIssue({ number: 1 })];
    const deps = makeDeps({
      getStatus: vi.fn(() => "succeeded" as Status),
      getMetadata: vi.fn(() => ({
        prUrl: "https://github.com/owner/repo/pull/10",
      })),
    });

    postRunSummaryComments(issues, makeConfig(), deps);

    const call = (deps.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].input).toContain("https://github.com/owner/repo/pull/10");
  });

  it("includes run ID and config name in comment", () => {
    const issues = [makeIssue({ number: 1 })];
    const deps = makeDeps({
      getStatus: vi.fn(() => "succeeded" as Status),
    });
    const config = makeConfig({ runId: "my-run-123", configName: "my-config" });

    postRunSummaryComments(issues, config, deps);

    const call = (deps.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].input).toContain("my-run-123");
    expect(call[1].input).toContain("my-config");
  });

  it("skips pending issues", () => {
    const issues = [makeIssue({ number: 1 })];
    const deps = makeDeps({
      getStatus: vi.fn(() => "pending" as Status),
    });

    postRunSummaryComments(issues, makeConfig(), deps);

    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("posts comments for failed issues", () => {
    const issues = [makeIssue({ number: 1 })];
    const deps = makeDeps({
      getStatus: vi.fn(() => "failed" as Status),
    });

    postRunSummaryComments(issues, makeConfig(), deps);

    const call = (deps.runCommand as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].input).toContain("failed");
  });

  it("continues when a comment post fails", () => {
    const issues = [
      makeIssue({ number: 1 }),
      makeIssue({ number: 2, slug: "second" }),
    ];
    let callCount = 0;
    const deps = makeDeps({
      getStatus: vi.fn(() => "succeeded" as Status),
      runCommand: vi.fn(() => {
        callCount++;
        if (callCount === 1) throw new Error("GitHub API error");
        return "";
      }),
    });

    // Should not throw
    postRunSummaryComments(issues, makeConfig(), deps);

    // Second issue's comment was still attempted
    expect(deps.runCommand).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("#1"),
    );
  });

  it("uses issue-specific repo when available", () => {
    const issues = [makeIssue({ number: 1, repo: "other/repo" })];
    const deps = makeDeps({
      getStatus: vi.fn(() => "succeeded" as Status),
    });

    postRunSummaryComments(issues, makeConfig({ repo: "default/repo" }), deps);

    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 1 --repo other/repo --body-file -",
      expect.anything(),
    );
  });
});
