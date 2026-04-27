import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { seedFromGit } from "../src/seed-from-git.js";

describe("seedFromGit", () => {
  it("returns 1 when no matching files exist on the base branch", () => {
    const runCommand = vi.fn().mockReturnValue("");
    const next = seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    expect(next).toBe(1);
  });

  it("returns max(captured) + 1 across matching files", () => {
    const runCommand = vi.fn().mockReturnValue(
      [
        "migrations/0001_init.sql",
        "migrations/0042_users.sql",
        "migrations/0056_orders.sql",
      ].join("\n"),
    );
    const next = seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    expect(next).toBe(57);
  });

  it("ignores files that do not match the regex", () => {
    const runCommand = vi.fn().mockReturnValue(
      [
        "migrations/0001_init.sql",
        "migrations/notes.md",
        "migrations/README",
      ].join("\n"),
    );
    const next = seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    expect(next).toBe(2);
  });

  it("takes the max across multiple paths", () => {
    const runCommand = vi
      .fn()
      .mockReturnValueOnce("") // fetch
      .mockReturnValueOnce("a/0001_x.sql\na/0010_y.sql")
      .mockReturnValueOnce("b/0099_z.sql");
    const next = seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        paths: [
          { dir: "a", pattern: "a/(\\d{4})_.*\\.sql" },
          { dir: "b", pattern: "b/(\\d{4})_.*\\.sql" },
        ],
      },
    );
    expect(next).toBe(100);
  });

  it("fetches origin/<baseBranch> before scanning", () => {
    const runCommand = vi.fn().mockReturnValue("");
    seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    expect(runCommand.mock.calls[0]![0]).toContain("fetch origin main");
  });

  it("continues scanning when the fetch fails", () => {
    let call = 0;
    const runCommand = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) throw new Error("offline");
      return "migrations/0042_users.sql";
    });
    const next = seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "main",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    expect(next).toBe(43);
  });

  it("returns 1 when git fails (treats as empty repo)", () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error("not a git repo");
    });
    const next = seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/nope",
        baseBranch: "main",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    expect(next).toBe(1);
  });

  it("uses the configured base branch", () => {
    const runCommand = vi.fn().mockReturnValue("");
    seedFromGit(
      { runCommand },
      {
        repoDir: "/tmp/repo",
        baseBranch: "develop",
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
      },
    );
    const lsTreeCmd = runCommand.mock.calls[1]![0];
    expect(lsTreeCmd).toContain("origin/develop");
  });
});

describe("ESM safety", () => {
  it("source contains no inline require() calls", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/seed-from-git.ts", import.meta.url)),
      "utf-8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });
});
