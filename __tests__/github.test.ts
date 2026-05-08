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
      "gh issue edit 42 --repo 'owner/repo' --add-label 'bug'",
    );
  });

  it("shell-quotes label with colon", () => {
    const deps = makeDeps();
    addIssueLabel("owner/repo", 1, "status:running", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 1 --repo 'owner/repo' --add-label 'status:running'",
    );
  });

  it("shell-quotes label containing spaces", () => {
    const deps = makeDeps();
    addIssueLabel("owner/repo", 1, "needs review", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 1 --repo 'owner/repo' --add-label 'needs review'",
    );
  });

  it("shell-quotes label containing single quote", () => {
    const deps = makeDeps();
    addIssueLabel("owner/repo", 1, "Jake's label", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 1 --repo 'owner/repo' --add-label 'Jake'\\''s label'",
    );
  });

  it("shell-quotes label containing dollar sign and backtick", () => {
    const deps = makeDeps();
    addIssueLabel("owner/repo", 1, "$label`name`", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 1 --repo 'owner/repo' --add-label '$label`name`'",
    );
  });

  it("shell-quotes repo containing spaces", () => {
    const deps = makeDeps();
    addIssueLabel("owner/my repo", 1, "bug", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 1 --repo 'owner/my repo' --add-label 'bug'",
    );
  });
});

describe("removeIssueLabel", () => {
  it("calls gh issue edit with --remove-label", () => {
    const deps = makeDeps();
    removeIssueLabel("owner/repo", 42, "bug", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 42 --repo 'owner/repo' --remove-label 'bug'",
    );
  });

  it("shell-quotes label and repo with shell metacharacters", () => {
    const deps = makeDeps();
    removeIssueLabel("owner/repo", 1, "$bad`label", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue edit 1 --repo 'owner/repo' --remove-label '$bad`label'",
    );
  });
});

describe("postIssueComment", () => {
  it("calls gh issue comment with --body-file - and pipes body via stdin", () => {
    const deps = makeDeps();
    postIssueComment("owner/repo", 42, "Hello world", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 42 --repo 'owner/repo' --body-file -",
      { input: "Hello world" },
    );
  });

  it("handles multi-line markdown bodies", () => {
    const deps = makeDeps();
    const body = "## Status\n\n- [x] Done\n- [ ] Pending\n\n> Quote with `code`";
    postIssueComment("owner/repo", 1, body, deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 1 --repo 'owner/repo' --body-file -",
      { input: body },
    );
  });

  it("handles bodies with special characters", () => {
    const deps = makeDeps();
    const body = 'Body with "quotes" and $variables and `backticks`';
    postIssueComment("owner/repo", 1, body, deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 1 --repo 'owner/repo' --body-file -",
      { input: body },
    );
  });

  it("shell-quotes repo with spaces and metacharacters", () => {
    const deps = makeDeps();
    postIssueComment("owner/my repo", 1, "body", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue comment 1 --repo 'owner/my repo' --body-file -",
      { input: "body" },
    );
  });
});

describe("ensureLabelExists", () => {
  it("calls gh label create with --force for idempotent creation", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "status:running", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create 'status:running' --repo 'owner/repo' --force",
    );
  });

  it("accepts optional color parameter", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "bug", deps, { color: "d73a4a" });
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create 'bug' --repo 'owner/repo' --force --color 'd73a4a'",
    );
  });

  it("accepts optional description parameter", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "bug", deps, {
      description: "Something isn't working",
    });
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create 'bug' --repo 'owner/repo' --force --description 'Something isn'\\''t working'",
    );
  });

  it("shell-quotes label and repo with spaces", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/my repo", "needs review", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create 'needs review' --repo 'owner/my repo' --force",
    );
  });

  it("shell-quotes label containing dollar sign and backtick", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "$meta`label", deps);
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create '$meta`label' --repo 'owner/repo' --force",
    );
  });

  it("shell-quotes description with dollar sign", () => {
    const deps = makeDeps();
    ensureLabelExists("owner/repo", "bug", deps, {
      description: "costs $5 per unit",
    });
    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh label create 'bug' --repo 'owner/repo' --force --description 'costs $5 per unit'",
    );
  });
});
