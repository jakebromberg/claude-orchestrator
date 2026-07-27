import { describe, it, expect } from "vitest";
import path from "node:path";
import { refOf } from "../src/ref.js";
import { deriveWorktreeHooks } from "../src/worktree-hooks.js";
import type { Issue } from "../src/types.js";

function makeIssue(repo: string | undefined, slug = "my-slug", number = 1): Issue {
  const base = { number, slug, dependsOn: [], description: "d", repo };
  return { ...base, wave: 1, ref: refOf(base), deps: [] };
}

interface GitCall {
  args: string[];
  cwd: string;
}

/**
 * Fake git runner. Responds to `rev-parse --abbrev-ref origin/HEAD` with the
 * configured base, and lets each `worktree add` / `worktree remove` be
 * programmed to succeed or throw.
 */
function makeGit(opts: {
  base?: string;
  addBehavior?: ("ok" | "throw")[];
  removeBehavior?: "ok" | "throw";
} = {}) {
  const calls: GitCall[] = [];
  let addIdx = 0;
  const runGit = (args: string[], cwd: string): string => {
    calls.push({ args, cwd });
    if (args.includes("rev-parse")) {
      return `origin/${opts.base ?? "main"}\n`;
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const behavior = opts.addBehavior?.[addIdx++] ?? "ok";
      if (behavior === "throw") throw new Error("git worktree add failed");
      return "";
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      if (opts.removeBehavior === "throw") throw new Error("git worktree remove failed");
      return "";
    }
    return "";
  };
  return { runGit, calls };
}

const REPOS = "/repos/WXYC";

/** Default I/O: repo dir present, worktree absent, nothing created yet. */
function makeIo(present: string[] = []) {
  const created: string[] = [];
  const existing = new Set(present);
  return {
    created,
    existsSync: (p: string) => existing.has(p),
    mkdirSync: (p: string) => {
      created.push(p);
      existing.add(p);
    },
    markExists: (p: string) => existing.add(p),
  };
}

describe("deriveWorktreeHooks — path derivation", () => {
  it("getWorktreePath strips the owner and uses the sibling <repo>-worktrees layout", () => {
    const hooks = deriveWorktreeHooks({ reposDir: REPOS });
    const issue = makeIssue("WXYC/library-metadata-lookup", "add-cache");
    expect(hooks.getWorktreePath(issue)).toBe(
      "/repos/WXYC/library-metadata-lookup-worktrees/add-cache",
    );
  });

  it("getBranchName defaults to orchestrator/<slug>", () => {
    const hooks = deriveWorktreeHooks({ reposDir: REPOS });
    expect(hooks.getBranchName(makeIssue("WXYC/lml", "fix-thing"))).toBe(
      "orchestrator/fix-thing",
    );
  });

  it("getBranchName honors an override", () => {
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      getBranchName: (i) => `feature/${i.slug}`,
    });
    expect(hooks.getBranchName(makeIssue("WXYC/lml", "fix-thing"))).toBe(
      "feature/fix-thing",
    );
  });

  it("reposDir defaults to ~/Developer/WXYC", () => {
    const hooks = deriveWorktreeHooks();
    const issue = makeIssue("WXYC/wxyc-canary", "probe");
    const expected = path.join(
      process.env.HOME!,
      "Developer/WXYC/wxyc-canary-worktrees/probe",
    );
    expect(hooks.getWorktreePath(issue)).toBe(expected);
  });

  it("worktreeRoot override is respected", () => {
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      worktreeRoot: (repoDir) => `${repoDir}.worktrees`,
    });
    expect(hooks.getWorktreePath(makeIssue("WXYC/lml", "s"))).toBe(
      "/repos/WXYC/lml.worktrees/s",
    );
  });

  it("issues in different repos resolve to isolated worktree roots", () => {
    const hooks = deriveWorktreeHooks({ reposDir: REPOS });
    const a = hooks.getWorktreePath(makeIssue("WXYC/Backend-Service", "epic", 1));
    const b = hooks.getWorktreePath(makeIssue("WXYC/library-metadata-lookup", "epic", 2));
    expect(a).toBe("/repos/WXYC/Backend-Service-worktrees/epic");
    expect(b).toBe("/repos/WXYC/library-metadata-lookup-worktrees/epic");
  });

  it("default repoOf throws when the issue has no repo", () => {
    const hooks = deriveWorktreeHooks({ reposDir: REPOS });
    expect(() => hooks.getWorktreePath(makeIssue(undefined, "s"))).toThrow(/repo/i);
  });

  it("repoOf override is respected", () => {
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      repoOf: () => "custom-dir",
    });
    expect(hooks.getWorktreePath(makeIssue("WXYC/whatever", "s"))).toBe(
      "/repos/WXYC/custom-dir-worktrees/s",
    );
  });
});

describe("deriveWorktreeHooks — setUpWorktree", () => {
  it("creates the worktree root, then adds a branch off the derived base", async () => {
    const git = makeGit({ base: "main" });
    const io = makeIo([`${REPOS}/library-metadata-lookup`]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });
    const issue = makeIssue("WXYC/library-metadata-lookup", "add-cache");

    await hooks.setUpWorktree(issue);

    const repoDir = `${REPOS}/library-metadata-lookup`;
    const wtRoot = `${repoDir}-worktrees`;
    const wtPath = `${wtRoot}/add-cache`;
    expect(io.created).toContain(wtRoot);
    const add = git.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    expect(add).toEqual({
      args: ["worktree", "add", wtPath, "-b", "orchestrator/add-cache", "main"],
      cwd: repoDir,
    });
  });

  it("derives the base branch per-repo from origin/HEAD (iOS master, not main)", async () => {
    const git = makeGit({ base: "master" });
    const repoDir = `${REPOS}/wxyc-ios-64`;
    const io = makeIo([repoDir]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await hooks.setUpWorktree(makeIssue("WXYC/wxyc-ios-64", "on-tour-tab"));

    const add = git.calls.find((c) => c.args[1] === "add")!;
    expect(add.args).toEqual([
      "worktree",
      "add",
      `${repoDir}-worktrees/on-tour-tab`,
      "-b",
      "orchestrator/on-tour-tab",
      "master",
    ]);
    // The rev-parse ran against the iOS checkout, not a hardcoded assumption.
    const revParse = git.calls.find((c) => c.args.includes("rev-parse"))!;
    expect(revParse.cwd).toBe(repoDir);
  });

  it("never hardcodes main: an explicit baseBranchOf override wins", async () => {
    const git = makeGit(); // rev-parse would say main, but override should preempt it
    const repoDir = `${REPOS}/lml`;
    const io = makeIo([repoDir]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      baseBranchOf: () => "develop",
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await hooks.setUpWorktree(makeIssue("WXYC/lml", "s"));

    const add = git.calls.find((c) => c.args[1] === "add")!;
    expect(add.args[add.args.length - 1]).toBe("develop");
    // No rev-parse when baseBranchOf is supplied.
    expect(git.calls.some((c) => c.args.includes("rev-parse"))).toBe(false);
  });

  it("falls back to checking out an existing branch when create fails", async () => {
    const git = makeGit({ base: "main", addBehavior: ["throw", "ok"] });
    const repoDir = `${REPOS}/lml`;
    const io = makeIo([repoDir]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await hooks.setUpWorktree(makeIssue("WXYC/lml", "s"));

    const adds = git.calls.filter((c) => c.args[1] === "add");
    expect(adds).toHaveLength(2);
    // Second attempt omits -b and reuses the existing branch.
    expect(adds[1].args).toEqual([
      "worktree",
      "add",
      `${repoDir}-worktrees/s`,
      "orchestrator/s",
    ]);
  });

  it("tolerates an already-present worktree (both adds fail, dir exists)", async () => {
    const git = makeGit({ base: "main", addBehavior: ["throw", "throw"] });
    const repoDir = `${REPOS}/lml`;
    const wtPath = `${repoDir}-worktrees/s`;
    const io = makeIo([repoDir, wtPath]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await expect(hooks.setUpWorktree(makeIssue("WXYC/lml", "s"))).resolves.toBeUndefined();
  });

  it("throws when both adds fail and no worktree exists", async () => {
    const git = makeGit({ base: "main", addBehavior: ["throw", "throw"] });
    const repoDir = `${REPOS}/lml`;
    const io = makeIo([repoDir]); // worktree path absent
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await expect(hooks.setUpWorktree(makeIssue("WXYC/lml", "s"))).rejects.toThrow(
      /worktree/i,
    );
  });

  it("throws a clear error when the repo checkout is missing", async () => {
    const git = makeGit({ base: "main" });
    const io = makeIo([]); // repoDir absent
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await expect(hooks.setUpWorktree(makeIssue("WXYC/lml", "s"))).rejects.toThrow(
      /repo.*not found|not found.*repo/i,
    );
    // Never attempted an add against a missing checkout.
    expect(git.calls.some((c) => c.args[1] === "add")).toBe(false);
  });
});

describe("deriveWorktreeHooks — removeWorktree", () => {
  it("removes an existing worktree with --force", async () => {
    const git = makeGit();
    const repoDir = `${REPOS}/lml`;
    const wtPath = `${repoDir}-worktrees/s`;
    const io = makeIo([repoDir, wtPath]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await hooks.removeWorktree(makeIssue("WXYC/lml", "s"));

    expect(git.calls).toEqual([
      { args: ["worktree", "remove", wtPath, "--force"], cwd: repoDir },
    ]);
  });

  it("is a no-op when the worktree is absent", async () => {
    const git = makeGit();
    const io = makeIo([`${REPOS}/lml`]); // worktree path absent
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await hooks.removeWorktree(makeIssue("WXYC/lml", "s"));
    expect(git.calls).toEqual([]);
  });

  it("swallows git errors (best effort)", async () => {
    const git = makeGit({ removeBehavior: "throw" });
    const repoDir = `${REPOS}/lml`;
    const wtPath = `${repoDir}-worktrees/s`;
    const io = makeIo([repoDir, wtPath]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await expect(hooks.removeWorktree(makeIssue("WXYC/lml", "s"))).resolves.toBeUndefined();
  });
});

describe("deriveWorktreeHooks — default baseBranchOf", () => {
  it("strips the origin/ prefix from origin/HEAD", async () => {
    const git = makeGit({ base: "trunk" });
    const repoDir = `${REPOS}/lml`;
    const io = makeIo([repoDir]);
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit: git.runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await hooks.setUpWorktree(makeIssue("WXYC/lml", "s"));

    const add = git.calls.find((c) => c.args[1] === "add")!;
    expect(add.args[add.args.length - 1]).toBe("trunk");
  });

  it("throws an actionable error when origin/HEAD can't be resolved", async () => {
    const repoDir = `${REPOS}/lml`;
    const io = makeIo([repoDir]);
    const runGit = (args: string[], _cwd: string): string => {
      if (args.includes("rev-parse")) throw new Error("no origin/HEAD");
      return "";
    };
    const hooks = deriveWorktreeHooks({
      reposDir: REPOS,
      runGit,
      existsSync: io.existsSync,
      mkdirSync: io.mkdirSync,
    });

    await expect(hooks.setUpWorktree(makeIssue("WXYC/lml", "s"))).rejects.toThrow(
      /base branch|origin\/HEAD/i,
    );
  });
});
