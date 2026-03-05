import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("returns run-all with defaults for empty args", () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      mode: "run-all",
      wave: undefined,
      issues: [],
      maxParallel: 4,
      mergeAfterWave: false,
      detach: false,
      notify: false,
    });
  });

  it("parses --help", () => {
    expect(parseArgs(["--help"]).mode).toBe("help");
  });

  it("parses -h", () => {
    expect(parseArgs(["-h"]).mode).toBe("help");
  });

  it("parses --status", () => {
    expect(parseArgs(["--status"]).mode).toBe("status");
  });

  it("parses --cleanup", () => {
    expect(parseArgs(["--cleanup"]).mode).toBe("cleanup");
  });

  it("parses --watch", () => {
    expect(parseArgs(["--watch"]).mode).toBe("watch");
  });

  it("parses --retry-failed", () => {
    expect(parseArgs(["--retry-failed"]).mode).toBe("retry-failed");
  });

  it("parses --merge", () => {
    expect(parseArgs(["--merge"]).mode).toBe("merge");
  });

  it("parses --merge-after-wave", () => {
    const result = parseArgs(["--merge-after-wave"]);
    expect(result.mergeAfterWave).toBe(true);
  });

  it("combines --merge-after-wave with --wave", () => {
    const result = parseArgs(["--merge-after-wave", "--wave", "1"]);
    expect(result.mergeAfterWave).toBe(true);
    expect(result.wave).toBe(1);
  });

  it("parses --wave N", () => {
    const result = parseArgs(["--wave", "2"]);
    expect(result.mode).toBe("run-all");
    expect(result.wave).toBe(2);
  });

  it("throws when --wave has no argument", () => {
    expect(() => parseArgs(["--wave"])).toThrow("--wave requires an argument");
  });

  it("throws when --wave is followed by another flag", () => {
    expect(() => parseArgs(["--wave", "--status"])).toThrow(
      "--wave requires an argument",
    );
  });

  it("parses --parallel N", () => {
    const result = parseArgs(["--parallel", "6"]);
    expect(result.maxParallel).toBe(6);
  });

  it("throws when --parallel has no argument", () => {
    expect(() => parseArgs(["--parallel"])).toThrow(
      "--parallel requires a number",
    );
  });

  it("throws when --parallel is followed by another flag", () => {
    expect(() => parseArgs(["--parallel", "--wave"])).toThrow(
      "--parallel requires a number",
    );
  });

  it("parses positional issue numbers as run-specific", () => {
    const result = parseArgs(["3", "4", "5"]);
    expect(result.mode).toBe("run-specific");
    expect(result.issues).toEqual([3, 4, 5]);
  });

  it("throws on unknown option", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown option: --unknown");
  });

  it("combines --wave with specific issues", () => {
    const result = parseArgs(["--wave", "1", "3"]);
    expect(result.mode).toBe("run-specific");
    expect(result.wave).toBe(1);
    expect(result.issues).toEqual([3]);
  });

  it("combines --parallel with other args", () => {
    const result = parseArgs(["--parallel", "8", "--wave", "2"]);
    expect(result.maxParallel).toBe(8);
    expect(result.wave).toBe(2);
  });

  it("parses --detach with mode staying run-all", () => {
    const result = parseArgs(["--detach"]);
    expect(result.mode).toBe("run-all");
    expect(result.detach).toBe(true);
  });

  it("parses --notify", () => {
    const result = parseArgs(["--notify"]);
    expect(result.notify).toBe(true);
  });

  it("parses --tail as tail mode", () => {
    const result = parseArgs(["--tail"]);
    expect(result.mode).toBe("tail");
  });

  it("combines --detach + --notify + --merge-after-wave", () => {
    const result = parseArgs(["--detach", "--notify", "--merge-after-wave"]);
    expect(result.detach).toBe(true);
    expect(result.notify).toBe(true);
    expect(result.mergeAfterWave).toBe(true);
    expect(result.mode).toBe("run-all");
  });

  it("defaults detach and notify to false", () => {
    const result = parseArgs(["--wave", "1"]);
    expect(result.detach).toBe(false);
    expect(result.notify).toBe(false);
  });

  describe("decompose flags", () => {
    it("parses --decompose", () => {
      const result = parseArgs(["--decompose"]);
      expect(result.mode).toBe("decompose");
    });

    it("parses --decompose --file path", () => {
      const result = parseArgs(["--decompose", "--file", "/path/to/spec.md"]);
      expect(result.mode).toBe("decompose");
      expect(result.decomposeFile).toBe("/path/to/spec.md");
    });

    it("throws when --file has no argument", () => {
      expect(() => parseArgs(["--decompose", "--file"])).toThrow("--file requires a path");
    });

    it("parses --create-issues flag", () => {
      const result = parseArgs(["--decompose", "--create-issues"]);
      expect(result.createIssues).toBe(true);
    });

    it("parses --issue number", () => {
      const result = parseArgs(["--decompose", "--issue", "42"]);
      expect(result.decomposeIssue).toBe(42);
    });

    it("throws when --issue has no argument", () => {
      expect(() => parseArgs(["--decompose", "--issue"])).toThrow("--issue requires a number");
    });

    it("parses --repo owner/repo", () => {
      const result = parseArgs(["--decompose", "--repo", "owner/repo"]);
      expect(result.decomposeRepo).toBe("owner/repo");
    });

    it("throws when --repo has no argument", () => {
      expect(() => parseArgs(["--decompose", "--repo"])).toThrow("--repo requires owner/repo");
    });

    it("combines all decompose flags", () => {
      const result = parseArgs([
        "--decompose",
        "--file", "/spec.md",
        "--issue", "10",
        "--repo", "owner/repo",
        "--create-issues",
      ]);
      expect(result.mode).toBe("decompose");
      expect(result.decomposeFile).toBe("/spec.md");
      expect(result.decomposeIssue).toBe(10);
      expect(result.decomposeRepo).toBe("owner/repo");
      expect(result.createIssues).toBe(true);
    });
  });

  describe("dashboard flags", () => {
    it("parses --dashboard", () => {
      const result = parseArgs(["--dashboard"]);
      expect(result.mode).toBe("dashboard");
    });

    it("parses --dashboard with --port", () => {
      const result = parseArgs(["--dashboard", "--port", "8080"]);
      expect(result.mode).toBe("dashboard");
      expect(result.port).toBe(8080);
    });

    it("throws when --port has no value", () => {
      expect(() => parseArgs(["--port"])).toThrow("--port requires a number");
    });

    it("throws when --port value starts with -", () => {
      expect(() => parseArgs(["--port", "--dashboard"])).toThrow("--port requires a number");
    });
  });
});
