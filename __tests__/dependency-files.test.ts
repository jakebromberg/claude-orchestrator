import { describe, it, expect } from "vitest";
import { getDependencyFiles } from "../src/dependency-files.js";
import type { Issue, IssueMetadata } from "../src/types.js";

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

describe("getDependencyFiles", () => {
  it("returns empty array when issue has no deps", () => {
    const issue = makeIssue({ number: 3, deps: [] });
    const result = getDependencyFiles(issue, [issue], () => ({}));
    expect(result).toEqual([]);
  });

  it("returns files from a single dependency", () => {
    const dep = makeIssue({ number: 1, deps: [] });
    const issue = makeIssue({ number: 2, deps: [1] });
    const metadata: Record<number, IssueMetadata> = {
      1: { filesChanged: ["src/engine.ts", "src/types.ts"] },
    };

    const result = getDependencyFiles(
      issue,
      [dep, issue],
      (n) => metadata[n] ?? {},
    );
    expect(result).toEqual(["src/engine.ts", "src/types.ts"]);
  });

  it("deduplicates files from multiple dependencies", () => {
    const dep1 = makeIssue({ number: 1, deps: [] });
    const dep2 = makeIssue({ number: 2, deps: [] });
    const issue = makeIssue({ number: 3, deps: [1, 2] });
    const metadata: Record<number, IssueMetadata> = {
      1: { filesChanged: ["src/engine.ts", "src/types.ts"] },
      2: { filesChanged: ["src/types.ts", "src/cli.ts"] },
    };

    const result = getDependencyFiles(
      issue,
      [dep1, dep2, issue],
      (n) => metadata[n] ?? {},
    );
    expect(result).toEqual(["src/cli.ts", "src/engine.ts", "src/types.ts"]);
  });

  it("returns sorted file list", () => {
    const dep = makeIssue({ number: 1, deps: [] });
    const issue = makeIssue({ number: 2, deps: [1] });
    const metadata: Record<number, IssueMetadata> = {
      1: { filesChanged: ["z.ts", "a.ts", "m.ts"] },
    };

    const result = getDependencyFiles(
      issue,
      [dep, issue],
      (n) => metadata[n] ?? {},
    );
    expect(result).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("handles deps with no filesChanged metadata", () => {
    const dep = makeIssue({ number: 1, deps: [] });
    const issue = makeIssue({ number: 2, deps: [1] });

    const result = getDependencyFiles(
      issue,
      [dep, issue],
      () => ({ prUrl: "https://github.com/org/repo/pull/1" }),
    );
    expect(result).toEqual([]);
  });

  it("handles deps with empty filesChanged array", () => {
    const dep = makeIssue({ number: 1, deps: [] });
    const issue = makeIssue({ number: 2, deps: [1] });
    const metadata: Record<number, IssueMetadata> = {
      1: { filesChanged: [] },
    };

    const result = getDependencyFiles(
      issue,
      [dep, issue],
      (n) => metadata[n] ?? {},
    );
    expect(result).toEqual([]);
  });
});
