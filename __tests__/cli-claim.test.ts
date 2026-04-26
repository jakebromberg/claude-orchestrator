import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { parseClaimArgs, runClaim } from "../src/cli-claim.js";
import { InMemoryCounterStore } from "../src/counter-store.js";
import type { YamlConfig } from "../src/yaml-types.js";

function baseYaml(): YamlConfig {
  return {
    name: "T",
    configDir: "/tmp/cfg",
    worktreeDir: "/tmp/wt",
    projectRoot: "/tmp/proj",
    stallTimeout: 0,
    issues: [],
    sequentialDomains: {
      migrations: {
        paths: [{ dir: "migrations", pattern: "(\\d{4})_.*\\.sql" }],
        width: 4,
      },
    },
  };
}

describe("parseClaimArgs", () => {
  it("parses all required flags", () => {
    const a = parseClaimArgs([
      "--config",
      "/path/to/config.yaml",
      "--issue",
      "42",
      "--domain",
      "migrations",
    ]);
    expect(a).toEqual({
      config: "/path/to/config.yaml",
      issue: 42,
      domain: "migrations",
    });
  });

  it("throws when --config is missing", () => {
    expect(() =>
      parseClaimArgs(["--issue", "42", "--domain", "migrations"]),
    ).toThrow(/--config/);
  });

  it("throws when --issue is missing", () => {
    expect(() =>
      parseClaimArgs([
        "--config",
        "/x.yaml",
        "--domain",
        "migrations",
      ]),
    ).toThrow(/--issue/);
  });

  it("throws when --domain is missing", () => {
    expect(() =>
      parseClaimArgs(["--config", "/x.yaml", "--issue", "1"]),
    ).toThrow(/--domain/);
  });

  it("throws on unknown flags", () => {
    expect(() =>
      parseClaimArgs([
        "--config",
        "/x.yaml",
        "--issue",
        "1",
        "--domain",
        "m",
        "--bogus",
      ]),
    ).toThrow(/Unknown/);
  });

  it("throws when --issue is not a number", () => {
    expect(() =>
      parseClaimArgs([
        "--config",
        "/x.yaml",
        "--issue",
        "abc",
        "--domain",
        "m",
      ]),
    ).toThrow(/--issue/);
  });
});

describe("runClaim", () => {
  it("returns the seeded number on first claim", () => {
    const store = new InMemoryCounterStore();
    const result = runClaim({
      yaml: baseYaml(),
      issue: 1,
      domain: "migrations",
      store,
      seed: () => 57,
    });
    expect(result).toBe("0057");
  });

  it("increments across distinct issues in the same domain", () => {
    const store = new InMemoryCounterStore();
    runClaim({
      yaml: baseYaml(),
      issue: 1,
      domain: "migrations",
      store,
      seed: () => 57,
    });
    const result = runClaim({
      yaml: baseYaml(),
      issue: 2,
      domain: "migrations",
      store,
      seed: () => 999,
    });
    expect(result).toBe("0058");
  });

  it("returns the same number on a retry of the same issue", () => {
    const store = new InMemoryCounterStore();
    const a = runClaim({
      yaml: baseYaml(),
      issue: 1,
      domain: "migrations",
      store,
      seed: () => 57,
    });
    const b = runClaim({
      yaml: baseYaml(),
      issue: 1,
      domain: "migrations",
      store,
      seed: () => 999,
    });
    expect(b).toBe(a);
  });

  it("throws when the domain is unknown", () => {
    const store = new InMemoryCounterStore();
    expect(() =>
      runClaim({
        yaml: baseYaml(),
        issue: 1,
        domain: "nonexistent",
        store,
        seed: () => 1,
      }),
    ).toThrow(/Unknown domain/);
  });

  it("throws when sequentialDomains is not configured", () => {
    const store = new InMemoryCounterStore();
    const yaml: YamlConfig = { ...baseYaml(), sequentialDomains: undefined };
    expect(() =>
      runClaim({
        yaml,
        issue: 1,
        domain: "migrations",
        store,
        seed: () => 1,
      }),
    ).toThrow(/sequentialDomains/);
  });
});

describe("ESM safety", () => {
  it("source contains no inline require() calls", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/cli-claim.ts", import.meta.url)),
      "utf-8",
    );
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\brequire\s*\(/);
  });
});
