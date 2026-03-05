import { describe, it, expect, vi } from "vitest";
import {
  addIssueLabel,
  removeIssueLabel,
  postIssueComment,
  ensureLabelExists,
  type GitHubDeps,
} from "../src/github.js";

function makeDeps(
  overrides: Partial<GitHubDeps> = {},
): GitHubDeps {
  return {
    runCommand: vi.fn(() => ""),
    ...overrides,
  };
}

describe("addIssueLabel", () => {
  it("calls gh issue edit with --add-label", () => {
    const deps = makeDeps();
    addIssueLabel("owner/repo", 42, "bug", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 42 --repo owner/repo --add-label "bug"',
    );
  });

  it("escapes label with quotes", () => {
    const deps = makeDeps();
    addIssueLabel("owner/repo", 1, "status:running", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 1 --repo owner/repo --add-label "status:running"',
    );
  });
});

describe("removeIssueLabel", () => {
  it("calls gh issue edit with --remove-label", () => {
    const deps = makeDeps();
    removeIssueLabel("owner/repo", 42, "bug", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh issue edit 42 --repo owner/repo --remove-label "bug"',
    );
  });
});

describe("postIssueComment", () => {
  it("calls gh issue comment with --body-file - and pipes body via stdin", () => {
    const deps = makeDeps();
    postIssueComment("owner/repo", 42, "Hello world", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 42 --repo owner/repo --body-file -",
      { input: "Hello world" },
    );
  });

  it("handles multi-line markdown bodies", () => {
    const deps = makeDeps();
    const body = "## Status\n\n- [x] Done\n- [ ] Pending\n\n> Quote with `code`";
    postIssueComment("owner/repo", 1, body, deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 1 --repo owner/repo --body-file -",
      { input: body },
    );
  });

  it("handles bodies with special characters", () => {
    const deps = makeDeps();
    const body = 'Body with "quotes" and $variables and `backticks`';
    postIssueComment("owner/repo", 1, body, deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 1 --repo owner/repo --body-file -",
      { input: body },
    );
  });
});

describe("ensureLabelExists", () => {
  it("calls gh label create with --force for idempotent creation", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "status:running", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh label create "status:running" --repo owner/repo --force',
    );
  });

  it("accepts optional color parameter", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "bug", deps, { color: "d73a4a" });
    expect(deps.runCommand).toHaveBeenCalledWith(
      'gh label create "bug" --repo owner/repo --force --color d73a4a',
    );
  });

  it("accepts optional description parameter", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "bug", deps, {
      description: "Something isn't working",
    });
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create \"bug\" --repo owner/repo --force --description \"Something isn\\'t working\"",
    );
  });
});
