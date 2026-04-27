import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  detectCollisions,
  gatherCollisionInputs,
  type CollisionInput,
  type SequentialPathEntry,
} from "../src/collision-check.js";

const sqlEntry: SequentialPathEntry = {
  dir: "migrations",
  pattern: "(\\d{4})_.*\\.sql",
};
const changelogEntry: SequentialPathEntry = {
  dir: "changelog",
  pattern: "(\\d{6})-.*\\.json",
};

function input(overrides: Partial<CollisionInput> = {}): CollisionInput {
  return {
    entries: [sqlEntry],
    current: {},
    peers: {},
    shipped: {},
    ...overrides,
  };
}

describe("detectCollisions", () => {
  it("returns no collision when current is empty", () => {
    const result = detectCollisions(input());
    expect(result.collided).toBe(false);
    expect(result.details).toEqual([]);
  });

  it("returns no collision when current adds keys nobody else has", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_add_x.sql" }] },
        peers: { bar: { 0: [{ key: "0055", path: "migrations/0055_old.sql" }] } },
        shipped: { 0: [{ key: "0050", path: "migrations/0050_init.sql" }] },
      }),
    );
    expect(result.collided).toBe(false);
  });

  it("flags a collision when a peer worktree added the same key", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_a.sql" }] },
        peers: { bar: { 0: [{ key: "0056", path: "migrations/0056_b.sql" }] } },
      }),
    );
    expect(result.collided).toBe(true);
    expect(result.details).toHaveLength(1);
    const detail = result.details[0]!;
    expect(detail.entryIndex).toBe(0);
    expect(detail.key).toBe("0056");
    expect(detail.myFile).toBe("migrations/0056_a.sql");
    expect(detail.peers).toEqual([{ slug: "bar", path: "migrations/0056_b.sql" }]);
    expect(detail.shippedFiles).toEqual([]);
    expect(result.summary).toContain("0056");
    expect(result.summary).toContain("bar");
    expect(result.summary).toContain("migrations/0056_b.sql");
  });

  it("flags a collision against shipped (already-merged) peers", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_a.sql" }] },
        shipped: { 0: [{ key: "0056", path: "migrations/0056_shipped.sql" }] },
      }),
    );
    expect(result.collided).toBe(true);
    const detail = result.details[0]!;
    expect(detail.shippedFiles).toEqual(["migrations/0056_shipped.sql"]);
    expect(detail.peers).toEqual([]);
    expect(result.summary).toContain("origin");
  });

  it("treats different sequentialPaths entries as independent number spaces", () => {
    const result = detectCollisions({
      entries: [sqlEntry, changelogEntry],
      current: {
        0: [{ key: "0056", path: "migrations/0056_a.sql" }],
        1: [{ key: "000123", path: "changelog/000123-foo.json" }],
      },
      // Peer "bar" added 0056 in changelog (entry 1) and 0055 in sql (entry 0).
      // Neither key collides with current, since the spaces are independent.
      peers: {
        bar: {
          0: [{ key: "0055", path: "migrations/0055_x.sql" }],
          1: [{ key: "0056", path: "changelog/0056-y.json" }],
        },
      },
      shipped: {},
    });
    expect(result.collided).toBe(false);
  });

  it("flags collisions independently per entry", () => {
    const result = detectCollisions({
      entries: [sqlEntry, changelogEntry],
      current: {
        0: [{ key: "0056", path: "migrations/0056_a.sql" }],
        1: [{ key: "000123", path: "changelog/000123-foo.json" }],
      },
      peers: {
        bar: {
          0: [{ key: "0056", path: "migrations/0056_b.sql" }],
        },
      },
      shipped: {
        1: [{ key: "000123", path: "changelog/000123-bar.json" }],
      },
    });
    expect(result.collided).toBe(true);
    expect(result.details).toHaveLength(2);
    const sql = result.details.find((d) => d.entryIndex === 0)!;
    const log = result.details.find((d) => d.entryIndex === 1)!;
    expect(sql.peers).toHaveLength(1);
    expect(log.shippedFiles).toEqual(["changelog/000123-bar.json"]);
  });

  it("attributes collision to multiple peers when several worktrees collide on the same key", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_a.sql" }] },
        peers: {
          bar: { 0: [{ key: "0056", path: "migrations/0056_b.sql" }] },
          baz: { 0: [{ key: "0056", path: "migrations/0056_c.sql" }] },
        },
      }),
    );
    expect(result.collided).toBe(true);
    expect(result.details[0]!.peers).toHaveLength(2);
    expect(result.details[0]!.peers.map((p) => p.slug).sort()).toEqual(["bar", "baz"]);
  });

  it("computes nextSafeNumber as max(observed) + 1, zero-padded to source width", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_a.sql" }] },
        peers: { bar: { 0: [{ key: "0056", path: "migrations/0056_b.sql" }] } },
        shipped: { 0: [{ key: "0058", path: "migrations/0058_shipped.sql" }] },
      }),
    );
    expect(result.nextSafeNumber[0]).toBe("0059");
    expect(result.summary).toContain("0059");
  });

  it("returns nextSafeNumber=null when keys are non-numeric", () => {
    const result = detectCollisions({
      entries: [{ dir: "labels", pattern: "(.+)\\.txt" }],
      current: { 0: [{ key: "alpha", path: "labels/alpha.txt" }] },
      peers: { bar: { 0: [{ key: "alpha", path: "labels/alpha.txt" }] } },
      shipped: {},
    });
    expect(result.collided).toBe(true);
    expect(result.nextSafeNumber[0]).toBeNull();
  });

  it("ignores peer's own files when peer slug appears in 'peers' but adds different keys", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_a.sql" }] },
        peers: { bar: { 0: [{ key: "0057", path: "migrations/0057_x.sql" }] } },
      }),
    );
    expect(result.collided).toBe(false);
    // nextSafeNumber should still reflect peer observation
    expect(result.nextSafeNumber[0]).toBe("0058");
  });

  it("outputs structured details suitable for retry prompt injection", () => {
    const result = detectCollisions(
      input({
        current: { 0: [{ key: "0056", path: "migrations/0056_a.sql" }] },
        peers: { bar: { 0: [{ key: "0056", path: "migrations/0056_b.sql" }] } },
      }),
    );
    expect(result.output).toContain("0056");
    expect(result.output).toContain("bar");
    expect(result.output).toContain("0057");
    expect(result.output).toMatch(/next safe number/i);
  });
});

describe("gatherCollisionInputs", () => {
  it("fetches origin/<baseBranch> once before scanning", () => {
    const runCommand = vi.fn().mockReturnValue("");
    gatherCollisionInputs({
      runCommand,
      existsSync: () => false,
      currentWorktree: "/tmp/wt/foo",
      peers: [],
      entries: [sqlEntry],
      baseBranch: "main",
    });
    const fetchCall = runCommand.mock.calls.find(
      ([cmd]) =>
        cmd.includes("/tmp/wt/foo") &&
        cmd.includes("fetch origin") &&
        cmd.includes("main"),
    );
    expect(fetchCall).toBeDefined();
  });

  it("collects current's added files via diff against merge-base..HEAD", () => {
    const runCommand = vi.fn((cmd: string) => {
      if (cmd.includes("merge-base HEAD") && cmd.includes("origin/main"))
        return "abc123\n";
      if (cmd.includes("diff") && cmd.includes("abc123..HEAD")) {
        return "migrations/0056_add_x.sql\nmigrations/README.md\n";
      }
      return "";
    });
    const result = gatherCollisionInputs({
      runCommand,
      existsSync: () => false,
      currentWorktree: "/tmp/wt/foo",
      peers: [],
      entries: [sqlEntry],
      baseBranch: "main",
    });
    expect(result.current[0]).toEqual([{ key: "0056", path: "migrations/0056_add_x.sql" }]);
  });

  it("skips peers whose worktree directory does not exist", () => {
    const runCommand = vi.fn().mockReturnValue("");
    const existsSync = vi.fn().mockReturnValue(false);
    const result = gatherCollisionInputs({
      runCommand,
      existsSync,
      currentWorktree: "/tmp/wt/foo",
      peers: [{ slug: "bar", worktreePath: "/tmp/wt/bar" }],
      entries: [sqlEntry],
      baseBranch: "main",
    });
    expect(result.peers).toEqual({});
    expect(existsSync).toHaveBeenCalledWith("/tmp/wt/bar");
  });

  it("treats a peer with a broken git invocation as no-info, not fatal", () => {
    const runCommand = vi.fn((cmd: string) => {
      if (cmd.includes("/tmp/wt/bar")) throw new Error("not a git repository");
      return "";
    });
    const result = gatherCollisionInputs({
      runCommand,
      existsSync: () => true,
      currentWorktree: "/tmp/wt/foo",
      peers: [{ slug: "bar", worktreePath: "/tmp/wt/bar" }],
      entries: [sqlEntry],
      baseBranch: "main",
    });
    expect(result.peers).toEqual({ bar: {} });
  });

  it("shell-quotes worktree paths, refs, and entry dirs so spaces and metas are safe", () => {
    const runCommand = vi.fn().mockReturnValue("");
    gatherCollisionInputs({
      runCommand,
      existsSync: () => true,
      currentWorktree: "/tmp/with space",
      peers: [{ slug: "bar", worktreePath: "/tmp/peer's path" }],
      entries: [{ dir: "weird dir/$X", pattern: "(\\d+)" }],
      baseBranch: "feat/branch",
    });
    const cmds = runCommand.mock.calls.map((c) => c[0] as string);
    // Every call must wrap the worktree path, branch ref, and entry dir in
    // single quotes so the shell passes them as one argument each.
    expect(cmds.some((c) => c.includes(`'/tmp/with space'`))).toBe(true);
    expect(cmds.some((c) => c.includes(`'/tmp/peer'\\''s path'`))).toBe(true);
    expect(cmds.some((c) => c.includes(`'feat/branch'`))).toBe(true);
    expect(cmds.some((c) => c.includes(`'origin/feat/branch'`))).toBe(true);
  });

  it("collects shipped (origin since merge-base) added files in current worktree", () => {
    const runCommand = vi.fn((cmd: string) => {
      if (cmd.includes("merge-base HEAD") && cmd.includes("origin/main"))
        return "abc123\n";
      if (cmd.includes("abc123..HEAD")) return "";
      if (cmd.includes("abc123..origin/main")) {
        return "migrations/0056_shipped.sql\n";
      }
      return "";
    });
    const result = gatherCollisionInputs({
      runCommand,
      existsSync: () => false,
      currentWorktree: "/tmp/wt/foo",
      peers: [],
      entries: [sqlEntry],
      baseBranch: "main",
    });
    expect(result.shipped[0]).toEqual([
      { key: "0056", path: "migrations/0056_shipped.sql" },
    ]);
  });
});

// The package ships as ESM ("type": "module") so inline `require(...)` calls
// crash at runtime with "require is not defined". Vitest's esbuild transform
// hides this in unit tests by polyfilling `require`, so we guard the source
// text directly.
describe("ESM safety", () => {
  it("source contains no inline require() calls", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/collision-check.ts", import.meta.url)),
      "utf-8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });
});
