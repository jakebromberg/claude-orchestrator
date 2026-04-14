import { createMain, loadYamlConfig } from "@funlandresearch/claude-orchestrator";
import type { HooksOverride, Issue } from "@funlandresearch/claude-orchestrator";
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import path from "path";

const WXYC_ROOT = "/Users/jake/Developer/WXYC";
const CONFIG_DIR = path.dirname(new URL(import.meta.url).pathname);

// ── Repo metadata ────────────────────────────────────────────────────

/** Map orchestrator issue number -> { repo, ghIssue } */
const ISSUE_MAP: Record<number, { repo: string; ghIssue: number }> = {
  0:  { repo: "wxyc-etl",               ghIssue: 0  },  // synthetic scaffold
  1:  { repo: "wxyc-etl",               ghIssue: 1  },
  2:  { repo: "wxyc-etl",               ghIssue: 2  },
  3:  { repo: "wxyc-etl",               ghIssue: 3  },
  4:  { repo: "wxyc-etl",               ghIssue: 4  },
  5:  { repo: "wxyc-etl",               ghIssue: 5  },
  6:  { repo: "wxyc-etl",               ghIssue: 6  },
  7:  { repo: "wxyc-etl",               ghIssue: 7  },
  8:  { repo: "discogs-cache",           ghIssue: 63 },
  9:  { repo: "semantic-index",          ghIssue: 112 },
  10: { repo: "musicbrainz-cache",       ghIssue: 1  },
  11: { repo: "discogs-cache",           ghIssue: 64 },
  12: { repo: "semantic-index",          ghIssue: 113 },
  13: { repo: "discogs-xml-converter",   ghIssue: 21 },
  14: { repo: "wikidata-json-filter",    ghIssue: 1  },
  15: { repo: "wxyc-catalog",            ghIssue: 1  },
  16: { repo: "wxyc-catalog",            ghIssue: 2  },
  17: { repo: "discogs-cache",           ghIssue: 65 },
  18: { repo: "library-metadata-lookup", ghIssue: 95 },
  19: { repo: "semantic-index",          ghIssue: 114 },
  20: { repo: "library-metadata-lookup", ghIssue: 96 },
  21: { repo: "library-metadata-lookup", ghIssue: 97 },
  22: { repo: "library-metadata-lookup", ghIssue: 98 },
  23: { repo: "semantic-index",          ghIssue: 115 },
  24: { repo: "musicbrainz-cache",       ghIssue: 2  },
  25: { repo: "wikidata-json-filter",    ghIssue: 2  },
};

/** Default branch per repo. */
const DEFAULT_BRANCHES: Record<string, string> = {
  "wxyc-etl":               "main",
  "discogs-cache":          "main",
  "semantic-index":         "main",
  "musicbrainz-cache":      "main",
  "discogs-xml-converter":  "main",
  "wikidata-json-filter":   "main",
  "wxyc-catalog":           "main",
  "library-metadata-lookup": "main",
};

/** Repos that use Rust (cargo test). */
const RUST_REPOS = new Set([
  "wxyc-etl",
  "discogs-xml-converter",
  "wikidata-json-filter",
  "musicbrainz-cache",  // after issue 24 converts it to Rust
]);

/** Repos that use Python (pytest). */
const PYTHON_REPOS = new Set([
  "discogs-cache",
  "semantic-index",
  "musicbrainz-cache",
  "library-metadata-lookup",
  "wxyc-catalog",
]);

// ── Per-issue supervision policies ──────────────────────────────────

interface IssuePolicy {
  allowedPaths: string[];
  testCommand: string;
  maxWritesBeforeTest: number;
  requirePlanRead: boolean;
}

const HOOKS_DIR = path.join(CONFIG_DIR, "hooks");

const POLICY_MAP: Record<number, IssuePolicy> = {
  // Phase 1: each task owns its module directory (Cargo.toml/lib.rs are read-only, scaffolded by task 0)
  1:  { allowedPaths: ["src/text/**", "tests/**"],    testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  2:  { allowedPaths: ["src/pg/**", "tests/**"],      testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  3:  { allowedPaths: ["src/pipeline/**", "tests/**"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  4:  { allowedPaths: ["src/csv/**", "src/csv_mod/**", "src/sqlite/**", "src/state/**", "src/import/**", "src/schema/**", "tests/**"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  5:  { allowedPaths: ["src/fuzzy/**", "tests/**"],   testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  6:  { allowedPaths: ["src/parser/**", "tests/**"],  testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  7:  { allowedPaths: ["wxyc-etl-python/**", "pyproject.toml", "tests/**", "wxyc_etl/**"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  // Phase 2-6: broader access per repo (these are the only tasks in their worktrees)
  8:  { allowedPaths: ["scripts/**", "lib/**", "tests/**", "pyproject.toml"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  9:  { allowedPaths: ["semantic_index/**", "run_pipeline.py", "tests/**", "pyproject.toml"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  10: { allowedPaths: ["scripts/**", "tests/**", "pyproject.toml"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  11: { allowedPaths: ["scripts/**", "lib/**", "tests/**", "pyproject.toml"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  12: { allowedPaths: ["semantic_index/**", "rust/**", "tests/**", "pyproject.toml"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  13: { allowedPaths: ["src/**", "Cargo.toml", "tests/**"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  14: { allowedPaths: ["src/**", "Cargo.toml", "tests/**"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  15: { allowedPaths: ["src/**", "pyproject.toml", "tests/**", "README.md", "CLAUDE.md"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  16: { allowedPaths: ["src/**", "pyproject.toml", "tests/**"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  17: { allowedPaths: ["scripts/**", "lib/**", "tests/**", "pyproject.toml"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  18: { allowedPaths: ["**"], testCommand: "pytest", maxWritesBeforeTest: 8, requirePlanRead: true },
  19: { allowedPaths: ["semantic_index/**", "run_pipeline.py", "tests/**", "pyproject.toml", "CLAUDE.md"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  20: { allowedPaths: ["scripts/**", "routers/**", "config/**", "tests/**", "pyproject.toml", "main.py"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  21: { allowedPaths: ["scripts/**", "tests/**"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  22: { allowedPaths: ["scripts/**", "routers/**", "tests/**", "main.py"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  23: { allowedPaths: ["semantic_index/**", "run_pipeline.py", "tests/**", "pyproject.toml", "CLAUDE.md"], testCommand: "pytest", maxWritesBeforeTest: 5, requirePlanRead: true },
  24: { allowedPaths: ["src/**", "Cargo.toml", "tests/**", "schema/**", "docker-compose.yml", ".github/**"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
  25: { allowedPaths: ["src/**", "Cargo.toml", "tests/**", "schema/**", "docker-compose.yml"], testCommand: "cargo test", maxWritesBeforeTest: 5, requirePlanRead: true },
};

function writeIssuePolicyFiles(worktreePath: string, issue: Issue): void {
  const policy = POLICY_MAP[issue.number];
  if (!policy) return;

  const claudeDir = path.join(worktreePath, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Write the policy file
  writeFileSync(
    path.join(claudeDir, "issue-policy.json"),
    JSON.stringify({
      issueNumber: issue.number,
      ...policy,
    }, null, 2),
  );

  // Write settings.json with hooks
  writeFileSync(
    path.join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [
              { type: "command", command: path.join(HOOKS_DIR, "validate-file-path.sh"), timeout: 5 },
              { type: "command", command: path.join(HOOKS_DIR, "require-plan-read.sh"), timeout: 5 },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Write|Edit|Bash",
            hooks: [
              { type: "command", command: path.join(HOOKS_DIR, "require-tests.sh"), timeout: 5 },
              { type: "command", command: path.join(HOOKS_DIR, "track-plan-read.sh"), timeout: 5 },
            ],
          },
        ],
      },
    }, null, 2),
  );

  // Initialize supervision state
  writeFileSync(
    path.join(claudeDir, "supervision-state.json"),
    JSON.stringify({ writesSinceTest: 0, planRead: false }),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function repoDir(repo: string): string {
  return path.join(WXYC_ROOT, repo);
}

function worktreeDir(issue: Issue): string {
  return path.join(CONFIG_DIR, "worktrees", issue.slug);
}

function issueInfo(issue: Issue): { repo: string; ghIssue: number } {
  const info = ISSUE_MAP[issue.number];
  if (!info) throw new Error(`No ISSUE_MAP entry for orchestrator issue #${issue.number}`);
  return info;
}

function run(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, {
    cwd: opts?.cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function runInherit(cmd: string, opts?: { cwd?: string }): void {
  execSync(cmd, { cwd: opts?.cwd, stdio: "inherit" });
}

// ── Scaffolding ──────────────────────────────────────────────────────

/**
 * The scaffolding step (issue 0) creates the wxyc-etl repo with
 * Cargo.toml, src/lib.rs (all pub mod declarations), and empty module
 * directories. This lets Phase 1 tasks run in parallel without
 * conflicting on shared files.
 */
function isScaffoldIssue(issue: Issue): boolean {
  return issue.number === 0;
}

// ── Hook overrides ───────────────────────────────────────────────────

const hooksOverride: HooksOverride = {
  getWorktreePath(issue: Issue): string {
    return worktreeDir(issue);
  },

  getBranchName(issue: Issue): string {
    const { repo, ghIssue } = issueInfo(issue);
    if (isScaffoldIssue(issue)) return "feature/etl-scaffold";
    return `feature/etl-${repo}-${ghIssue}`;
  },

  async setUpWorktree(issue: Issue): Promise<void> {
    const { repo } = issueInfo(issue);
    const repoPath = repoDir(repo);
    const wt = worktreeDir(issue);
    const branch = hooksOverride.getBranchName!(issue);
    const base = DEFAULT_BRANCHES[repo] ?? "main";

    // Ensure worktree parent directory exists
    mkdirSync(path.dirname(wt), { recursive: true });

    // Remove stale worktree if it exists
    if (existsSync(wt)) {
      console.log(`Removing stale worktree for ${issue.slug}...`);
      runInherit(`git -C "${repoPath}" worktree remove --force "${wt}"`);
    }

    // For new repos (wxyc-etl, wxyc-catalog), ensure the repo exists
    if (!existsSync(repoPath)) {
      if (repo === "wxyc-etl" || repo === "wxyc-catalog") {
        console.log(`Creating new repo ${repo}...`);
        mkdirSync(repoPath, { recursive: true });
        runInherit(`git -C "${repoPath}" init`);
        runInherit(`git -C "${repoPath}" commit --allow-empty -m "Initial commit"`);
      } else {
        throw new Error(`Repo directory does not exist: ${repoPath}`);
      }
    }

    // Fetch latest from remote (skip for brand-new local-only repos)
    try {
      run(`git -C "${repoPath}" remote get-url origin`);
      runInherit(`git -C "${repoPath}" fetch origin ${base}`);
      runInherit(
        `git -C "${repoPath}" worktree add -b "${branch}" "${wt}" "origin/${base}"`
      );
    } catch {
      // No remote -- create worktree from local HEAD
      console.log(`No remote for ${repo}, creating worktree from local HEAD...`);
      try {
        runInherit(`git -C "${repoPath}" worktree add -b "${branch}" "${wt}" HEAD`);
      } catch {
        // Branch may already exist from a previous run
        runInherit(`git -C "${repoPath}" worktree add "${wt}" "${branch}"`);
      }
    }

    // Install dependencies based on project type
    if (existsSync(path.join(wt, "package.json"))) {
      console.log(`Installing Node dependencies for ${issue.slug}...`);
      runInherit(`npm install`, { cwd: wt });
    }

    if (existsSync(path.join(wt, "pyproject.toml"))) {
      console.log(`Installing Python dependencies for ${issue.slug}...`);
      try {
        // Use uv if available, fall back to pip
        try {
          run("which uv");
          runInherit(`uv pip install -e ".[dev]"`, { cwd: wt });
        } catch {
          runInherit(`pip install -e ".[dev]"`, { cwd: wt });
        }
      } catch {
        console.log(`pip/uv install failed for ${issue.slug} (may need venv), continuing...`);
      }
    }

    // For Rust repos, run cargo check to prime the build cache
    if (existsSync(path.join(wt, "Cargo.toml"))) {
      console.log(`Running cargo check for ${issue.slug}...`);
      try {
        runInherit(`cargo check`, { cwd: wt });
      } catch {
        console.log(`cargo check failed for ${issue.slug} (may be expected for scaffold), continuing...`);
      }
    }

    // Write per-issue supervision policy and hooks config
    writeIssuePolicyFiles(wt, issue);
  },

  async removeWorktree(issue: Issue): Promise<void> {
    const { repo } = issueInfo(issue);
    const repoPath = repoDir(repo);
    const wt = worktreeDir(issue);

    if (existsSync(wt)) {
      runInherit(`git -C "${repoPath}" worktree remove --force "${wt}"`);
    }
  },

  getClaudeArgs(issue: Issue): string[] {
    const { repo } = issueInfo(issue);
    const args: string[] = ["--include-hook-events"];

    // Always give access to wxyc-etl for Rust consumers and Python consumers
    if (repo !== "wxyc-etl") {
      const etlDir = repoDir("wxyc-etl");
      if (existsSync(etlDir)) {
        args.push("--add-dir", etlDir);
      }
    }

    // Python consumers of wxyc-catalog need catalog visibility
    if (repo !== "wxyc-catalog") {
      const catalogDir = repoDir("wxyc-catalog");
      if (existsSync(catalogDir)) {
        args.push("--add-dir", catalogDir);
      }
    }

    return args;
  },

  async interpolatePrompt(issue: Issue): Promise<string> {
    const { repo, ghIssue } = issueInfo(issue);
    const fs = await import("node:fs");
    const templatePath = path.join(CONFIG_DIR, "prompt.md");
    const template = fs.readFileSync(templatePath, "utf-8");

    // Replace template variables
    // {{ISSUE_NUMBER}} -> GitHub issue number (not orchestrator number)
    // {{SLUG}} -> repo name (used in `gh issue view ... --repo WXYC/{{SLUG}}`)
    // {{DESCRIPTION}} -> issue description from YAML
    const { interpolate } = await import("@funlandresearch/claude-orchestrator");

    // For the scaffolding step, use a special prompt
    if (isScaffoldIssue(issue)) {
      return [
        "You are setting up the `wxyc-etl` Rust crate skeleton.",
        "",
        "Create the following structure in your worktree:",
        "",
        "1. `Cargo.toml` with crate name `wxyc-etl`, edition 2021, and placeholder dependencies (serde, tokio, rayon, pyo3, rusqlite, csv, postgres, unicode-normalization, strsim).",
        "2. `src/lib.rs` with these `pub mod` declarations: `text`, `pg`, `pipeline`, `csv_mod`, `sqlite`, `state`, `import`, `schema`, `fuzzy`, `parser`.",
        "3. Empty module files: `src/text.rs`, `src/pg.rs`, `src/pipeline.rs`, `src/csv_mod.rs`, `src/sqlite.rs`, `src/state.rs`, `src/import.rs`, `src/schema.rs`, `src/fuzzy.rs`, `src/parser.rs` (or `src/<name>/mod.rs` directories -- prefer directories since each module will grow).",
        "4. A basic `.gitignore` for Rust (`/target`).",
        "5. A `README.md` with a one-line description.",
        "6. A `CLAUDE.md` with basic Rust repo conventions (cargo test, cargo clippy, edition 2021).",
        "",
        "Commit, push, and create a PR. Do not mention AI or Claude.",
      ].join("\n");
    }

    return interpolate(template, {
      ISSUE_NUMBER: String(ghIssue),
      SLUG: repo,
      DESCRIPTION: issue.description,
      projectRoot: WXYC_ROOT,
      configDir: CONFIG_DIR,
      worktreeDir: path.join(CONFIG_DIR, "worktrees"),
    });
  },

  async preRunSetup(): Promise<void> {
    // Ensure worktrees directory exists
    const wtRoot = path.join(CONFIG_DIR, "worktrees");
    mkdirSync(wtRoot, { recursive: true });

    // Ensure state directory exists
    const stateDir = path.join(CONFIG_DIR, "state");
    mkdirSync(stateDir, { recursive: true });

    console.log("Pre-run setup complete. Worktree and state directories ready.");
  },

  async preflightCheck(): Promise<void> {
    // Verify required tools are available
    const required = ["git", "cargo", "gh"];
    for (const tool of required) {
      try {
        run(`which ${tool}`);
      } catch {
        throw new Error(
          `Required tool '${tool}' not found on PATH. Install it before running.`
        );
      }
    }

    // Verify WXYC root exists
    if (!existsSync(WXYC_ROOT)) {
      throw new Error(`WXYC root directory not found: ${WXYC_ROOT}`);
    }

    // Verify at least one repo exists
    const knownRepos = ["discogs-cache", "semantic-index", "discogs-xml-converter"];
    const found = knownRepos.some((r) => existsSync(repoDir(r)));
    if (!found) {
      throw new Error(
        `No known WXYC repos found under ${WXYC_ROOT}. Expected at least one of: ${knownRepos.join(", ")}`
      );
    }
  },

  async postSessionCheck(issue: Issue, worktreePath: string) {
    const { repo } = issueInfo(issue);

    // Scaffolding step just needs files to exist
    if (isScaffoldIssue(issue)) {
      const libRs = path.join(worktreePath, "src", "lib.rs");
      if (!existsSync(libRs)) {
        return { passed: false, summary: "src/lib.rs not found after scaffolding" };
      }
      return { passed: true };
    }

    // Run appropriate test suite
    try {
      if (RUST_REPOS.has(repo) && existsSync(path.join(worktreePath, "Cargo.toml"))) {
        run("cargo test", { cwd: worktreePath });
      } else if (PYTHON_REPOS.has(repo) && existsSync(path.join(worktreePath, "pyproject.toml"))) {
        run("pytest", { cwd: worktreePath });
      }
    } catch (err) {
      const testFailure = (err as Error).message;
      return {
        passed: false,
        summary: `Tests failed:\n${testFailure}`,
        output: `In your previous attempt, the tests failed with:\n\n${testFailure}\n\nPlease fix the failing tests before creating a PR. Run the test suite after each change to verify.`,
      };
    }

    // Parse stream-json log for behavioral validation
    const logFile = path.join(CONFIG_DIR, "state", "logs", `issue-${issue.number}.log`);
    const violations: string[] = [];

    try {
      const logContent = readFileSync(logFile, "utf-8");

      // Check if agent read the plan
      const readPlan = logContent.includes("gh issue view") || logContent.includes("Implementation Plan");
      if (!readPlan) {
        violations.push("Agent did not read the implementation plan before working");
      }

      // Count hook blocks (exit code 2 events)
      const hookBlocks = (logContent.match(/"exit_code":\s*2/g) ?? []).length;
      if (hookBlocks > 10) {
        violations.push(`Agent triggered ${hookBlocks} hook blocks — may be fighting the supervision policies`);
      }
    } catch {
      // Log file may not exist or be in a different location — skip validation
    }

    if (violations.length > 0) {
      return {
        passed: false,
        summary: `Behavioral violations:\n${violations.map(v => `- ${v}`).join("\n")}`,
        output: `In your previous attempt, the following issues were detected:\n\n${violations.map(v => `- ${v}`).join("\n")}\n\nPlease address these issues. Start by reading the implementation plan via 'gh issue view', follow the TDD strategy, and run tests after each change.`,
      };
    }

    return { passed: true };
  },
};

// ── Entry point ──────────────────────────────────────────────────────

createMain({
  configs: {
    etl: (projectRoot) =>
      loadYamlConfig(path.join(CONFIG_DIR, "orchestrator.yaml"), { hooksOverride }),
  },
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
