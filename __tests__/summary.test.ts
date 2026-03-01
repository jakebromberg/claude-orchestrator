import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Issue, Status } from "../src/types.js";
import { createPrintSummary, type SummaryColumn, type SummaryOptions } from "../src/summary.js";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    slug: "test-issue",
    dependsOn: [],
    description: "Test issue",
    wave: 1,
    deps: [],
    ...overrides,
  };
}

describe("createPrintSummary", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function getOutput(): string {
    return spy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  const basicColumns: SummaryColumn[] = [
    { header: "Issue", width: 6, value: (i) => "#" + i.number },
    { header: "Description", width: 20, value: (i) => i.description },
    { header: "Status", width: 14, value: (_, s) => s },
  ];

  const basicOptions: SummaryOptions = {
    title: "Test Summary",
    columns: basicColumns,
  };

  it("prints the title in bold", () => {
    const print = createPrintSummary(basicOptions);
    print([], () => "pending");

    const output = getOutput();
    expect(output).toContain("Test Summary");
  });

  it("prints column headers", () => {
    const print = createPrintSummary(basicOptions);
    print([], () => "pending");

    const output = getOutput();
    expect(output).toContain("Issue");
    expect(output).toContain("Description");
    expect(output).toContain("Status");
  });

  it("prints a separator row", () => {
    const print = createPrintSummary(basicOptions);
    print([], () => "pending");

    const output = getOutput();
    expect(output).toContain("---");
  });

  it("prints issue rows", () => {
    const issues = [
      makeIssue({ number: 5, description: "First task" }),
      makeIssue({ number: 12, description: "Second task" }),
    ];
    const print = createPrintSummary(basicOptions);
    print(issues, () => "pending");

    const output = getOutput();
    expect(output).toContain("#5");
    expect(output).toContain("#12");
    expect(output).toContain("First task");
    expect(output).toContain("Second task");
  });

  it("truncates values to column width", () => {
    const issues = [makeIssue({ description: "A very long description that exceeds width" })];
    const narrow: SummaryColumn[] = [
      { header: "Desc", width: 10, value: (i) => i.description },
    ];
    const print = createPrintSummary({ title: "Test", columns: narrow });
    print(issues, () => "pending");

    const output = getOutput();
    // Description should be truncated to 10 chars
    expect(output).not.toContain("A very long description that exceeds width");
    expect(output).toContain("A very lon");
  });

  describe("status colorization", () => {
    const statuses: [Status, string][] = [
      ["succeeded", "\x1b[0;32m"],  // GREEN
      ["failed", "\x1b[0;31m"],     // RED
      ["running", "\x1b[1;33m"],    // YELLOW
      ["interrupted", "\x1b[1;33m"],// YELLOW
      ["skipped", "\x1b[2m"],       // DIM
      ["pending", "\x1b[0m"],       // NC (no color)
    ];

    it.each(statuses)("colors %s rows correctly", (status, expectedColor) => {
      const issues = [makeIssue({ number: 1 })];
      const print = createPrintSummary(basicOptions);
      print(issues, () => status);

      const output = getOutput();
      expect(output).toContain(expectedColor);
    });
  });

  describe("totals line", () => {
    it("counts statuses correctly", () => {
      const issues = [
        makeIssue({ number: 1 }),
        makeIssue({ number: 2 }),
        makeIssue({ number: 3 }),
        makeIssue({ number: 4 }),
        makeIssue({ number: 5 }),
        makeIssue({ number: 6 }),
      ];
      const statusMap: Record<number, Status> = {
        1: "succeeded",
        2: "succeeded",
        3: "failed",
        4: "running",
        5: "pending",
        6: "skipped",
      };
      const print = createPrintSummary(basicOptions);
      print(issues, (n) => statusMap[n]);

      const output = getOutput();
      expect(output).toContain("Succeeded: 2");
      expect(output).toContain("Failed: 1");
      expect(output).toContain("Running: 1");
      expect(output).toContain("Pending: 1");
      expect(output).toContain("Skipped: 1");
      expect(output).toContain("Total: 6");
    });

    it("handles all-pending issues", () => {
      const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];
      const print = createPrintSummary(basicOptions);
      print(issues, () => "pending");

      const output = getOutput();
      expect(output).toContain("Succeeded: 0");
      expect(output).toContain("Pending: 2");
      expect(output).toContain("Total: 2");
    });
  });

  describe("extraTotals", () => {
    it("appends extra totals text when provided", () => {
      const options: SummaryOptions = {
        ...basicOptions,
        extraTotals: (issues) => `(${issues.length} custom)`,
      };
      const issues = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];
      const print = createPrintSummary(options);
      print(issues, () => "pending");

      const output = getOutput();
      expect(output).toContain("(2 custom)");
    });

    it("omits extra text when extraTotals is not provided", () => {
      const issues = [makeIssue({ number: 1 })];
      const print = createPrintSummary(basicOptions);
      print(issues, () => "pending");

      const output = getOutput();
      expect(output).toContain("Total: 1");
      // No trailing extra content
      const totalsLine = spy.mock.calls
        .map((c) => c.join(" "))
        .find((line) => line.includes("Total:"))!;
      expect(totalsLine).not.toContain("(");
    });
  });

  it("returns a function matching the printSummary hook signature", () => {
    const print = createPrintSummary(basicOptions);
    expect(typeof print).toBe("function");
    // Should accept (issues, getStatus) and return void
    const result = print([], () => "pending");
    expect(result).toBeUndefined();
  });
});
