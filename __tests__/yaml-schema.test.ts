import { describe, it, expect } from "vitest";
import { YamlConfigSchema } from "../src/yaml-schema.js";
import type { YamlConfig } from "../src/yaml-types.js";

function makeValid(overrides: Partial<YamlConfig> = {}): unknown {
  return {
    name: "Test",
    configDir: "./config",
    worktreeDir: "./worktrees",
    projectRoot: ".",
    stallTimeout: 300,
    issues: [
      { number: 1, slug: "foo", dependsOn: [], description: "Foo" },
    ],
    ...overrides,
  };
}

describe("YamlConfigSchema", () => {
  describe("valid configs", () => {
    it("accepts a minimal valid config", () => {
      const result = YamlConfigSchema.safeParse(makeValid());
      expect(result.success).toBe(true);
    });

    it("accepts all optional fields", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          allowedTools: ["Bash", "Read"],
          branchPrefix: "parity/",
          retryableStatuses: ["failed", "interrupted"],
          promptTemplate: "./prompt.md",
          claudeArgs: ["--add-dir", "{{projectRoot}}"],
          postSessionCheck: { commands: ["npm test"], cwd: "scripts" },
          summary: {
            title: "Summary",
            columns: [
              { header: "Issue", width: 6, value: "issue.number", prefix: "#" },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts postSessionCheck without cwd", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({ postSessionCheck: { commands: ["npm test"] } }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts summary columns without prefix", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          summary: {
            title: "T",
            columns: [{ header: "Status", width: 14, value: "status" }],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts issues with optional fields", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          issues: [
            {
              number: 1,
              slug: "foo",
              dependsOn: [],
              description: "Foo",
              repo: "org/repo",
              mode: "fast",
              stallTimeout: 600,
            },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts stallTimeout of 0", () => {
      const result = YamlConfigSchema.safeParse(makeValid({ stallTimeout: 0 }));
      expect(result.success).toBe(true);
    });
  });

  describe("invalid configs", () => {
    it("rejects missing name", () => {
      const input = makeValid() as Record<string, unknown>;
      delete input.name;
      expect(YamlConfigSchema.safeParse(input).success).toBe(false);
    });

    it("rejects empty name", () => {
      expect(YamlConfigSchema.safeParse(makeValid({ name: "" })).success).toBe(false);
    });

    it("rejects missing issues", () => {
      const input = makeValid() as Record<string, unknown>;
      delete input.issues;
      expect(YamlConfigSchema.safeParse(input).success).toBe(false);
    });

    it("rejects negative stallTimeout", () => {
      expect(
        YamlConfigSchema.safeParse(makeValid({ stallTimeout: -1 })).success,
      ).toBe(false);
    });

    it("rejects non-integer stallTimeout", () => {
      expect(
        YamlConfigSchema.safeParse(makeValid({ stallTimeout: 1.5 })).success,
      ).toBe(false);
    });

    it("rejects issue with empty slug", () => {
      expect(
        YamlConfigSchema.safeParse(
          makeValid({
            issues: [{ number: 1, slug: "", dependsOn: [], description: "X" }],
          }),
        ).success,
      ).toBe(false);
    });

    it("rejects issue with negative number", () => {
      expect(
        YamlConfigSchema.safeParse(
          makeValid({
            issues: [{ number: -1, slug: "a", dependsOn: [], description: "X" }],
          }),
        ).success,
      ).toBe(false);
    });

    it("rejects empty postSessionCheck commands", () => {
      expect(
        YamlConfigSchema.safeParse(
          makeValid({ postSessionCheck: { commands: [] } }),
        ).success,
      ).toBe(false);
    });

    it("rejects summary with no columns", () => {
      expect(
        YamlConfigSchema.safeParse(
          makeValid({ summary: { title: "T", columns: [] } }),
        ).success,
      ).toBe(false);
    });

    it("rejects summary column with zero width", () => {
      expect(
        YamlConfigSchema.safeParse(
          makeValid({
            summary: {
              title: "T",
              columns: [{ header: "X", width: 0, value: "status" }],
            },
          }),
        ).success,
      ).toBe(false);
    });

    it("rejects sequentialPaths pattern that does not compile as a regex", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialPaths: [{ dir: "migrations", pattern: "(unbalanced" }],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects sequentialPaths pattern with no capture group", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialPaths: [{ dir: "migrations", pattern: "\\d{4}_.*\\.sql" }],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("does not count non-capturing (?:) as a capture group", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialPaths: [
            { dir: "migrations", pattern: "(?:\\d{4})_.*\\.sql" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("sequentialPaths and baseBranch", () => {
    it("accepts sequentialPaths with a capture-group pattern", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialPaths: [
            { dir: "migrations", pattern: "(\\d{4})_.*\\.sql" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts baseBranch override", () => {
      const result = YamlConfigSchema.safeParse(makeValid({ baseBranch: "trunk" }));
      expect(result.success).toBe(true);
    });

    it("accepts multiple sequentialPaths entries", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialPaths: [
            { dir: "migrations", pattern: "(\\d{4})_.*\\.sql" },
            { dir: "changelog", pattern: "(\\d{6})-.*\\.json" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("sequentialDomains", () => {
    it("accepts a domain with paths and width", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts multiple domains", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
            changelog: {
              paths: [{ dir: "changelog", pattern: "(\\d{6})-.*\\.json" }],
              width: 6,
            },
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects an empty paths list", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialDomains: {
            migrations: { paths: [], width: 4 },
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a non-positive width", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 0,
            },
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a domain name with a path separator", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialDomains: {
            "foo/bar": {
              paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
              width: 4,
            },
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects a domain pattern with no capture group", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          sequentialDomains: {
            migrations: {
              paths: [{ dir: "migrations", pattern: "\\d{4}_.*\\.sql" }],
              width: 4,
            },
          },
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("appendableFiles", () => {
    it("accepts a valid appendableFiles entry", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          appendableFiles: [
            {
              path: "shared/db/meta/_journal.json",
              format: "json-array",
              arrayPath: "entries",
              keyField: "idx",
            },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts multiple appendableFiles entries", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          appendableFiles: [
            { path: "db/_journal.json", format: "json-array", arrayPath: "entries", keyField: "idx" },
            { path: "logs/changelog.json", format: "json-array", arrayPath: "log.items", keyField: "id" },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects an unknown format", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          appendableFiles: [
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { path: "db/_journal.json", format: "csv" as any, arrayPath: "entries", keyField: "idx" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an entry with an empty path", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          appendableFiles: [
            { path: "", format: "json-array", arrayPath: "entries", keyField: "idx" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an entry with an empty keyField", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          appendableFiles: [
            { path: "db/_journal.json", format: "json-array", arrayPath: "entries", keyField: "" },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("defaults", () => {
    it("defaults dependsOn to empty array when omitted", () => {
      const input = makeValid({
        issues: [{ number: 1, slug: "a", description: "X" } as any],
      });
      const result = YamlConfigSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.issues[0].dependsOn).toEqual([]);
      }
    });
  });

  describe("ownsFiles", () => {
    it("accepts an issue with ownsFiles", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          issues: [
            {
              number: 1,
              slug: "a",
              dependsOn: [],
              description: "X",
              ownsFiles: ["src/foo.ts", "src/bar.ts"],
            },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts an issue with an empty ownsFiles array", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          issues: [
            { number: 1, slug: "a", dependsOn: [], description: "X", ownsFiles: [] },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects ownsFiles with an empty string entry", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({
          issues: [
            { number: 1, slug: "a", dependsOn: [], description: "X", ownsFiles: [""] },
          ],
        }),
      );
      expect(result.success).toBe(false);
    });

    it("accepts a config-level sharedFiles allowlist", () => {
      const result = YamlConfigSchema.safeParse(
        makeValid({ sharedFiles: ["package-lock.json", "tests/mocks/db.mock.ts"] }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts an empty config-level sharedFiles list", () => {
      const result = YamlConfigSchema.safeParse(makeValid({ sharedFiles: [] }));
      expect(result.success).toBe(true);
    });

    it("rejects sharedFiles with an empty string entry", () => {
      const result = YamlConfigSchema.safeParse(makeValid({ sharedFiles: [""] }));
      expect(result.success).toBe(false);
    });
  });
});
