import { describe, it, expect } from "vitest";
import { generateReport, formatReport } from "../src/report.js";
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

describe("generateReport", () => {
  it("includes config name and timing", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const end = new Date("2026-01-01T00:05:00Z");
    const report = generateReport(
      "Test Orchestrator",
      [],
      () => "pending" as Status,
      () => ({}),
      start,
      end,
    );

    expect(report.configName).toBe("Test Orchestrator");
    expect(report.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(report.finishedAt).toBe("2026-01-01T00:05:00.000Z");
    expect(report.durationSeconds).toBe(300);
  });

  it("includes per-issue status and PR metadata", () => {
    const issues = [
      makeIssue({ number: 1, wave: 1, description: "First" }),
      makeIssue({ number: 2, wave: 2, description: "Second" }),
    ];
    const statuses: Record<number, Status> = { 1: "succeeded", 2: "failed" };
    const metadata: Record<number, IssueMetadata> = {
      1: { prUrl: "https://github.com/org/repo/pull/10", prNumber: 10 },
      2: {},
    };

    const report = generateReport(
      "Test",
      issues,
      (n) => statuses[n] ?? "pending",
      (n) => metadata[n] ?? {},
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:01:00Z"),
    );

    expect(report.issues).toHaveLength(2);
    expect(report.issues[0]).toMatchObject({
      number: 1,
      status: "succeeded",
      prUrl: "https://github.com/org/repo/pull/10",
      prNumber: 10,
    });
    expect(report.issues[1]).toMatchObject({
      number: 2,
      status: "failed",
    });
    expect(report.issues[1].prUrl).toBeUndefined();
  });
});

describe("formatReport", () => {
  it("produces markdown with header and table", () => {
    const report = generateReport(
      "My Config",
      [
        makeIssue({ number: 1, wave: 1, description: "Task A" }),
        makeIssue({ number: 2, wave: 2, description: "Task B" }),
      ],
      (n) => (n === 1 ? "succeeded" : "failed") as Status,
      (n) =>
        n === 1
          ? { prUrl: "https://github.com/org/repo/pull/5", prNumber: 5 }
          : {},
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:02:30Z"),
    );

    const md = formatReport(report);

    expect(md).toContain("# My Config — Run Report");
    expect(md).toContain("1 succeeded, 1 failed");
    expect(md).toContain("| #1 | Task A | 1 | succeeded |");
    expect(md).toContain("[#5](https://github.com/org/repo/pull/5)");
    expect(md).toContain("| #2 | Task B | 2 | failed | — |");
    expect(md).toContain("## Next Steps");
    expect(md).toContain("#2");
  });

  it("omits next steps when no failures", () => {
    const report = generateReport(
      "Test",
      [makeIssue({ number: 1 })],
      () => "succeeded" as Status,
      () => ({}),
      new Date(),
      new Date(),
    );

    const md = formatReport(report);
    expect(md).not.toContain("## Next Steps");
  });
});
