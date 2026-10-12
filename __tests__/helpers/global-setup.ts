import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Env var naming the run-level directory under which each test file's temp home is created. */
export const HOME_ROOT_VAR = "CO_TEST_HOME_ROOT";

// Vitest `globalSetup` entry (vitest.config.ts). Vitest skips a file's `afterAll` hooks when all its tests are skipped
// (e.g. under `-t`), so per-file homes would leak; the teardown here removes whatever the files left.
export default function setup(): () => void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "co-homes-")));
  process.env[HOME_ROOT_VAR] = root;
  return () => {
    delete process.env[HOME_ROOT_VAR];
    // A file whose tests are all skipped never runs its afterAll, so a write made while it was collected is only visible here.
    // Every home starts with an empty `lease` directory planted under the state directory; anything else is a write.
    const stray = readdirSync(root).filter((home) => {
      const state = join(root, home, ".local", "state", "claude-orchestrator");
      return existsSync(state) && readdirSync(state, { recursive: true }).some((rel) => String(rel) !== "lease");
    });
    rmSync(root, { recursive: true, force: true });
    // Throw only after the removal, so the root is never left behind.
    if (stray.length > 0) throw new Error(`Default lease directory written outside a test in: ${stray.map((home) => join(root, home)).join(", ")}`);
  };
}
