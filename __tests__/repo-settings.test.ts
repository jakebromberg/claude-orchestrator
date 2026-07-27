import { describe, it, expect } from "vitest";
import {
  resolveRepoSettings,
  allAppendableFiles,
  unknownRepoKeys,
} from "../src/repo-settings.js";
import type { YamlConfig } from "../src/yaml-types.js";

function makeYaml(overrides: Partial<YamlConfig> = {}): YamlConfig {
  return {
    name: "Test",
    configDir: "/c",
    worktreeDir: "/w",
    projectRoot: "/p",
    stallTimeout: 300,
    issues: [],
    ...overrides,
  };
}

describe("resolveRepoSettings", () => {
  describe("baseBranch", () => {
    it("defaults to 'main' with no repos map and no top-level baseBranch", () => {
      expect(resolveRepoSettings(makeYaml(), undefined).baseBranch).toBe("main");
    });

    it("uses the top-level baseBranch when set and repoKey is undefined", () => {
      expect(
        resolveRepoSettings(makeYaml({ baseBranch: "develop" }), undefined).baseBranch,
      ).toBe("develop");
    });

    it("uses the top-level baseBranch when the repoKey has no repos entry", () => {
      const yaml = makeYaml({
        baseBranch: "develop",
        repos: { "WXYC/wxyc-ios-64": { baseBranch: "master" } },
      });
      expect(resolveRepoSettings(yaml, "WXYC/Backend-Service").baseBranch).toBe("develop");
    });

    it("lets a repo override win over the top-level baseBranch", () => {
      const yaml = makeYaml({
        baseBranch: "main",
        repos: { "WXYC/wxyc-ios-64": { baseBranch: "master" } },
      });
      expect(resolveRepoSettings(yaml, "WXYC/wxyc-ios-64").baseBranch).toBe("master");
    });

    // The whole point of Phase A: iOS forks from master, siblings from main.
    it("regression: iOS resolves master while a main-repo resolves main", () => {
      const yaml = makeYaml({
        repos: { "WXYC/wxyc-ios-64": { baseBranch: "master" } },
      });
      expect(resolveRepoSettings(yaml, "WXYC/wxyc-ios-64").baseBranch).toBe("master");
      expect(resolveRepoSettings(yaml, "WXYC/library-metadata-lookup").baseBranch).toBe("main");
    });
  });

  describe("postSessionCheck", () => {
    it("is undefined when neither top-level nor repo set it", () => {
      expect(resolveRepoSettings(makeYaml(), "WXYC/x").postSessionCheck).toBeUndefined();
    });

    it("falls back to the top-level check when the repo has none", () => {
      const yaml = makeYaml({
        postSessionCheck: { commands: ["npm test"] },
        repos: { "WXYC/x": { baseBranch: "master" } },
      });
      expect(resolveRepoSettings(yaml, "WXYC/x").postSessionCheck).toEqual({
        commands: ["npm test"],
      });
    });

    it("replaces the top-level check wholesale when the repo defines its own", () => {
      const yaml = makeYaml({
        postSessionCheck: { commands: ["npm test"] },
        repos: {
          "WXYC/lml": { postSessionCheck: { commands: ["ruff check", "pytest"] } },
        },
      });
      expect(resolveRepoSettings(yaml, "WXYC/lml").postSessionCheck).toEqual({
        commands: ["ruff check", "pytest"],
      });
    });
  });

  describe("sequentialPaths and appendableFiles", () => {
    it("default to empty arrays", () => {
      const s = resolveRepoSettings(makeYaml(), undefined);
      expect(s.sequentialPaths).toEqual([]);
      expect(s.appendableFiles).toEqual([]);
    });

    it("fall back to top-level values", () => {
      const yaml = makeYaml({
        sequentialPaths: [{ dir: "migrations", pattern: "(\\d+)_.*" }],
        appendableFiles: [
          { path: "log.json", format: "json-array", arrayPath: "e", keyField: "id" },
        ],
      });
      const s = resolveRepoSettings(yaml, "WXYC/x");
      expect(s.sequentialPaths).toHaveLength(1);
      expect(s.appendableFiles).toHaveLength(1);
    });

    it("use per-repo values when set", () => {
      const yaml = makeYaml({
        sequentialPaths: [{ dir: "top", pattern: "(\\d+)" }],
        repos: {
          "WXYC/bs": {
            sequentialPaths: [{ dir: "apps/backend/migrations", pattern: "(\\d{4})_.*\\.sql" }],
          },
        },
      });
      expect(resolveRepoSettings(yaml, "WXYC/bs").sequentialPaths).toEqual([
        { dir: "apps/backend/migrations", pattern: "(\\d{4})_.*\\.sql" },
      ]);
      // A repo without its own paths still gets the top-level ones.
      expect(resolveRepoSettings(yaml, "WXYC/other").sequentialPaths).toEqual([
        { dir: "top", pattern: "(\\d+)" },
      ]);
    });
  });
});

describe("allAppendableFiles", () => {
  it("returns an empty array when none are configured", () => {
    expect(allAppendableFiles(makeYaml())).toEqual([]);
  });

  it("unions top-level and per-repo entries", () => {
    const yaml = makeYaml({
      appendableFiles: [
        { path: "shared.json", format: "json-array", arrayPath: "e", keyField: "id" },
      ],
      repos: {
        "WXYC/bs": {
          appendableFiles: [
            { path: "bs.json", format: "json-array", arrayPath: "e", keyField: "id" },
          ],
        },
      },
    });
    expect(allAppendableFiles(yaml).map((f) => f.path).sort()).toEqual(["bs.json", "shared.json"]);
  });

  it("dedupes identical specs at the same path to a single entry", () => {
    const yaml = makeYaml({
      appendableFiles: [
        { path: "dup.json", format: "json-array", arrayPath: "entries", keyField: "id" },
      ],
      repos: {
        "WXYC/bs": {
          appendableFiles: [
            { path: "dup.json", format: "json-array", arrayPath: "entries", keyField: "id" },
          ],
        },
      },
    });
    const all = allAppendableFiles(yaml);
    expect(all).toHaveLength(1);
    expect(all[0]!.arrayPath).toBe("entries");
  });

  it("throws when two specs share a path but disagree on how to merge it", () => {
    const yaml = makeYaml({
      appendableFiles: [
        { path: "dup.json", format: "json-array", arrayPath: "entries", keyField: "id" },
      ],
      repos: {
        "WXYC/bs": {
          appendableFiles: [
            { path: "dup.json", format: "json-array", arrayPath: "entries", keyField: "version" },
          ],
        },
      },
    });
    expect(() => allAppendableFiles(yaml)).toThrow(/dup\.json/);
  });
});

describe("unknownRepoKeys", () => {
  it("returns an empty array when there is no repos map", () => {
    expect(unknownRepoKeys(makeYaml())).toEqual([]);
  });

  it("flags a repos key that no issue references", () => {
    const yaml = makeYaml({
      issues: [{ number: 1, slug: "a", dependsOn: [], description: "A", repo: "WXYC/bs" }],
      repos: { "WXYC/typo-repo": { baseBranch: "master" } },
    });
    expect(unknownRepoKeys(yaml)).toEqual(["WXYC/typo-repo"]);
  });

  it("treats a key used by an issue's repo as known", () => {
    const yaml = makeYaml({
      issues: [{ number: 1, slug: "a", dependsOn: [], description: "A", repo: "WXYC/ios" }],
      repos: { "WXYC/ios": { baseBranch: "master" } },
    });
    expect(unknownRepoKeys(yaml)).toEqual([]);
  });

  it("treats the defaultRepo as known even when no issue names it explicitly", () => {
    const yaml = makeYaml({
      defaultRepo: "WXYC/bs",
      issues: [{ number: 1, slug: "a", dependsOn: [], description: "A" }],
      repos: { "WXYC/bs": { postSessionCheck: { commands: ["npm test"] } } },
    });
    expect(unknownRepoKeys(yaml)).toEqual([]);
  });
});
