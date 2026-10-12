import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["__tests__/**/*.test.ts"],
    globalSetup: ["__tests__/helpers/global-setup.ts"],
    setupFiles: ["__tests__/helpers/isolate-home.ts"],
  },
});
