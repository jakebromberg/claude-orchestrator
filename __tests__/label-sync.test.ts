import { describe, it, expect, vi } from "vitest";
import { createLabelSyncHandler, type LabelSyncDeps } from "../src/label-sync.js";
import type { Issue, Status, Logger } from "../src/types.js";

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

function makeDeps(overrides: Partial<LabelSyncDeps> = {}): LabelSyncDeps {
  return {
    runCommand: vi.fn(() => ""),
    logger: makeSilentLogger(),
    ...overrides,
  };
}

describe("createLabelSyncHandler", () => {
  it("adds new status label on transition to running", async () => {
    const deps = makeDeps();
    const handler = createLabelSyncHandler(
      { prefix: "orchestrator", repo: "owner/repo" },
      deps,
    );
    const issue = makeIssue({ number: 42 });

    await handler(issue, "pending", "running");

    // Should add running label (pending is not synced, so no remove)
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 42 --repo owner/repo --add-label "orchestrator:running"',
    );
  });

  it("removes old label and adds new on transition from running to succeeded", async () => {
    const deps = makeDeps();
    const handler = createLabelSyncHandler(
      { prefix: "status", repo: "owner/repo" },
      deps,
    );
    const issue = makeIssue({ number: 1 });

    await handler(issue, "running", "succeeded");

    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 1 --repo owner/repo --remove-label "status:running"',
    );
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 1 --repo owner/repo --add-label "status:succeeded"',
    );
  });

  it("removes old label and adds new on transition from running to failed", async () => {
    const deps = makeDeps();
    const handler = createLabelSyncHandler(
      { prefix: "ci", repo: "owner/repo" },
      deps,
    );
    const issue = makeIssue({ number: 5 });

    await handler(issue, "running", "failed");

    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 5 --repo owner/repo --remove-label "ci:running"',
    );
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 5 --repo owner/repo --add-label "ci:failed"',
    );
  });

  it("does not add/remove labels for non-synced statuses", async () => {
    const deps = makeDeps();
    const handler = createLabelSyncHandler(
      { prefix: "orchestrator", repo: "owner/repo" },
      deps,
    );
    const issue = makeIssue({ number: 1 });

    // Clear initial ensureLabelExists calls
    (deps.runCommand as ReturnType<typeof vi.fn>).mockClear();

    await handler(issue, "pending", "skipped");

    // Neither pending nor skipped are synced statuses
    expect(deps.runCommand).not.toHaveBeenCalled();
  });

  it("handles errors non-fatally", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(() => { throw new Error("GitHub API error"); }),
    });
    const handler = createLabelSyncHandler(
      { prefix: "orchestrator", repo: "owner/repo" },
      deps,
    );
    const issue = makeIssue({ number: 1 });

    // Should not throw
    await handler(issue, "pending", "running");

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Label sync failed"),
    );
  });

  it("uses issue-specific repo when available", async () => {
    const deps = makeDeps();
    const handler = createLabelSyncHandler(
      { prefix: "orchestrator", repo: "default/repo" },
      deps,
    );
    const issue = makeIssue({ number: 1, repo: "other/repo" });

    // Clear initial ensureLabelExists calls
    (deps.runCommand as ReturnType<typeof vi.fn>).mockClear();

    await handler(issue, "pending", "running");

    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 1 --repo other/repo --add-label "orchestrator:running"',
    );
  });

  it("ensures labels exist on creation", () => {
    const deps = makeDeps();
    createLabelSyncHandler(
      { prefix: "orchestrator", repo: "owner/repo" },
      deps,
    );

    // Should have called ensureLabelExists for running, succeeded, failed
    expect(deps.runCommand).toHaveBeenCalledWith(
      expect.stringContaining('gh label create "orchestrator:running"'),
    );
    expect(deps.runCommand).toHaveBeenCalledWith(
      expect.stringContaining('gh label create "orchestrator:succeeded"'),
    );
    expect(deps.runCommand).toHaveBeenCalledWith(
      expect.stringContaining('gh label create "orchestrator:failed"'),
    );
  });
});
