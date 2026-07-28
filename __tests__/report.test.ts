import { describe, it, expect } from "vitest";
import { refOf, normalizeDep } from "../src/ref.js";
import { generateReport, formatReport } from "../src/report.js";
import type { Issue, IssueMetadata, Status } from "../src/types.js";

function makeIssue(overrides: Omit<Partial<Issue>, "deps"> & { deps?: (number | string)[] } = {}): Issue {
  const { deps: depOverride, ref: refOverride, ...rest } = overrides;
  const base = {
    number: 1,
    slug: "test-issue",
    wave: 1,
    dependsOn: [],
    description: "Test issue",
    ...rest,
  };
  return {
    ...base,
    ref: refOverride ?? refOf(base),
    deps: (depOverride ?? []).map((d) => normalizeDep(d, base)),
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
      (n) => statuses[Number(n)] ?? "pending",
      (n) => metadata[Number(n)] ?? {},
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

  it("carries each issue's composite ref, keeping same-numbered cross-repo issues distinct", () => {
    // Two issues share the number 924 but live in different repos — the bare
    // `number` collides, so a consumer (ship-dag's review/merge pass) can only
    // map a report row back to (repo, PR) via the composite ref.
    const issues = [
      makeIssue({ number: 924, repo: "WXYC/library-metadata-lookup", wave: 1, description: "LML" }),
      makeIssue({ number: 924, repo: "WXYC/Backend-Service", wave: 1, description: "BS" }),
    ];
    const status: Record<string, Status> = {
      "WXYC/library-metadata-lookup#924": "succeeded",
      "WXYC/Backend-Service#924": "failed",
    };
    const meta: Record<string, IssueMetadata> = {
      "WXYC/library-metadata-lookup#924": {
        prUrl: "https://github.com/WXYC/library-metadata-lookup/pull/50",
        prNumber: 50,
      },
      "WXYC/Backend-Service#924": {},
    };

    const report = generateReport(
      "Cross-repo",
      issues,
      (ref) => status[ref] ?? "pending",
      (ref) => meta[ref] ?? {},
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:01:00Z"),
    );

    expect(report.issues[0]).toMatchObject({
      ref: "WXYC/library-metadata-lookup#924",
      number: 924,
      status: "succeeded",
      prNumber: 50,
    });
    expect(report.issues[1]).toMatchObject({
      ref: "WXYC/Backend-Service#924",
      number: 924,
      status: "failed",
    });
    // Same number, distinct refs — the disambiguator the consumer keys on.
    expect(report.issues[0].ref).not.toBe(report.issues[1].ref);
  });

  it("uses the bare number as the ref for a single-repo (repo-less) run", () => {
    const report = generateReport(
      "Single-repo",
      [makeIssue({ number: 7, wave: 1 })],
      () => "succeeded" as Status,
      () => ({}),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:01:00Z"),
    );

    expect(report.issues[0].ref).toBe("7");
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
      (n) => (n === "1" ? "succeeded" : "failed") as Status,
      (n) =>
        n === "1"
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

  it("labels rows by qualified ref in a cross-repo run", () => {
    const report = generateReport(
      "Cross-repo",
      [
        makeIssue({ number: 924, repo: "WXYC/library-metadata-lookup", wave: 1, description: "LML" }),
        makeIssue({ number: 924, repo: "WXYC/Backend-Service", wave: 1, description: "BS" }),
      ],
      (ref) => (ref === "WXYC/library-metadata-lookup#924" ? "succeeded" : "failed") as Status,
      () => ({}),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:01:00Z"),
    );

    const md = formatReport(report);
    // Qualified refs disambiguate the two same-numbered rows in both the table
    // and the failed-issues next-steps line.
    expect(md).toContain("| WXYC/library-metadata-lookup#924 | LML | 1 | succeeded |");
    expect(md).toContain("| WXYC/Backend-Service#924 | BS | 1 | failed | — |");
    expect(md).toContain("Failed: WXYC/Backend-Service#924");
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
