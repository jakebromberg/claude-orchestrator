import path from "node:path";
import { createMain } from "../../src/index.js";
import { loadYamlConfig } from "../../src/yaml-loader.js";
import hooksOverride from "./hooks.js";

const configPath = path.resolve(import.meta.dirname, "config.yaml");

createMain({
  configs: {
    "discogs-video": async () =>
      loadYamlConfig(configPath, { hooksOverride }),
  },
  projectRoot: path.resolve(import.meta.dirname, "../.."),
});
