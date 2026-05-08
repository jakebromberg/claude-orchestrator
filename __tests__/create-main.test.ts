import { describe, it, expect } from "vitest";
import {
  buildGhIssueCreateCommand,
  buildNotificationScript,
} from "../src/create-main.js";

describe("buildGhIssueCreateCommand", () => {
  it("produces a well-formed gh issue create command", () => {
    expect(buildGhIssueCreateCommand("owner/repo", "my-feature")).toBe(
      "gh issue create --repo 'owner/repo' --title 'my-feature' --body-file -",
    );
  });

  it("shell-quotes repo with spaces", () => {
    expect(buildGhIssueCreateCommand("owner/my repo", "slug")).toBe(
      "gh issue create --repo 'owner/my repo' --title 'slug' --body-file -",
    );
  });

  it("shell-quotes title containing single quote", () => {
    expect(buildGhIssueCreateCommand("owner/repo", "Jake's feature")).toBe(
      "gh issue create --repo 'owner/repo' --title 'Jake'\\''s feature' --body-file -",
    );
  });

  it("shell-quotes title containing dollar sign and backtick", () => {
    expect(buildGhIssueCreateCommand("owner/repo", "$title`name`")).toBe(
      "gh issue create --repo 'owner/repo' --title '$title`name`' --body-file -",
    );
  });
});

describe("buildNotificationScript", () => {
  it("produces valid AppleScript for a plain name", () => {
    expect(buildNotificationScript("My Project", "3 succeeded, 1 failed")).toBe(
      'display notification "3 succeeded, 1 failed" with title "My Project"',
    );
  });

  it("escapes double quotes in name using AppleScript string concatenation", () => {
    expect(buildNotificationScript('Project "X"', "1 succeeded, 0 failed")).toBe(
      'display notification "1 succeeded, 0 failed" with title "Project " & quote & "X" & quote & ""',
    );
  });

  it("passes single quotes, dollar signs, and backticks through unchanged", () => {
    // These are safe because execFileSync passes args without shell expansion.
    expect(buildNotificationScript("Jake's $project`s`", "2 succeeded, 0 failed")).toBe(
      "display notification \"2 succeeded, 0 failed\" with title \"Jake's $project`s`\"",
    );
  });

  it("handles name with only special characters", () => {
    expect(buildNotificationScript("$`'", "0 succeeded, 1 failed")).toBe(
      "display notification \"0 succeeded, 1 failed\" with title \"$`'\"",
    );
  });
});
