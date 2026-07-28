import path from "node:path";
import { createMain } from "../../dist/src/index.js";
import { loadYamlConfig } from "../../dist/src/yaml-loader.js";
import hooksOverride from "./hooks.ts";

const configPath = path.resolve(import.meta.dirname, "config.yaml");

createMain({
  configs: {
    "bs-1819": async () => loadYamlConfig(configPath, { hooksOverride }),
  },
  // Repo root (two levels up), so the --detach respawn resolves tsx from the
  // orchestrator's own node_modules.
  projectRoot: path.resolve(import.meta.dirname, "..", ".."),
});
