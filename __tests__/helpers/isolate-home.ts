import { afterAll, afterEach } from "vitest";
import { installIsolatedHome } from "./lease.js";

// Vitest `setupFiles` entry (vitest.config.ts): runs once per test file, before its tests are collected. See `installIsolatedHome`.
const isolated = installIsolatedHome();

afterEach((ctx) => {
  const stray = isolated.stray();
  if (stray.length === 0) return;
  isolated.reset();
  throw new Error(
    `"${ctx.task.name}" resolved the default lease directory and wrote under it (${stray.join(", ")}). ` +
      "Give the code under test an explicit CO_LEASE_DIR (a mkdtemp directory), built inside the test.",
  );
});

afterAll(() => isolated.dispose());
