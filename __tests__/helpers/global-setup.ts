import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
    rmSync(root, { recursive: true, force: true });
  };
}
