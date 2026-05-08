import path from "node:path";
import { createMain } from "../dist/src/index.js";
import { loadYamlConfig } from "../dist/src/yaml-loader.js";
import hooksOverride from "./hooks.ts";

const configPath = path.resolve(import.meta.dirname, "config.yaml");

createMain({
  configs: {
    "claude-orchestrator": async () =>
      loadYamlConfig(configPath, { hooksOverride }),
  },
  projectRoot: path.resolve(import.meta.dirname, ".."),
});
