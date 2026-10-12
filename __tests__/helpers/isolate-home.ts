import { afterAll, afterEach } from "vitest";
import { HOME_ROOT_VAR } from "./global-setup.js";
import { installIsolatedHome } from "./lease.js";

// Vitest `setupFiles` entry (vitest.config.ts): runs once per test file, before its tests are collected. See `installIsolatedHome`.
// The home goes under the run-level directory `global-setup.ts` removes, since a file with every test skipped never reaches its afterAll.
const isolated = installIsolatedHome(process.env[HOME_ROOT_VAR]);

const strayMessage = (what: string, stray: string[]): string =>
  `${what} resolved the default lease directory and wrote under it (${stray.join(", ")}). ` +
  "Give the code under test an explicit CO_LEASE_DIR (a mkdtemp directory), built inside the test.";

afterEach((ctx) => {
  const stray = isolated.stray();
  if (stray.length === 0) return;
  isolated.reset();
  throw new Error(strayMessage(`"${ctx.task.name}"`, stray));
});

// Registered first, so it runs after the file's own afterAll hooks (hooks run in stack order). The redirects stay in place:
// each file has its own worker, and restoring them would let late work resolve the account home.
afterAll(() => {
  const stray = isolated.stray();
  isolated.retire();
  if (stray.length > 0) throw new Error(strayMessage("This file (outside a test)", stray));
});
