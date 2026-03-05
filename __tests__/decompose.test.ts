import { describe, it, expect, vi } from "vitest";
import { decompose } from "../src/decompose.js";
import type { DecomposeDeps, DecomposeInput } from "../src/decompose-types.js";
import type { Logger } from "../src/types.js";

function makeSilentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    header: vi.fn(),
  };
}

function makeDeps(overrides: Partial<DecomposeDeps> = {}): DecomposeDeps {
  return {
    runCommand: vi.fn(() => ""),
    readFile: vi.fn(() => ""),
    logger: makeSilentLogger(),
    ...overrides,
  };
}

const validLlmOutput = JSON.stringify({
  issues: [
    { slug: "auth-module", description: "Build auth module", dependsOn: [] },
    { slug: "api-routes", description: "Add API routes", dependsOn: ["auth-module"] },
    { slug: "frontend", description: "Build frontend", dependsOn: ["api-routes"] },
  ],
});

describe("decompose", () => {
  it("returns decomposed issues from Claude CLI output", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(() => validLlmOutput),
    });
    const input: DecomposeInput = {
      featureDescription: "Build a user authentication system",
    };

    const result = await decompose(input, deps);

    expect(result.issues).toHaveLength(3);
    expect(result.issues[0]).toEqual({
      slug: "auth-module",
      description: "Build auth module",
      dependsOn: [],
    });
    expect(result.issues[1]).toEqual({
      slug: "api-routes",
      description: "Add API routes",
      dependsOn: ["auth-module"],
    });
  });

  it("generates a valid YAML fragment", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(() => validLlmOutput),
    });
    const input: DecomposeInput = {
      featureDescription: "Build a user authentication system",
    };

    const result = await decompose(input, deps);

    expect(result.yamlFragment).toContain("slug: auth-module");
    expect(result.yamlFragment).toContain("slug: api-routes");
    expect(result.yamlFragment).toContain("slug: frontend");
    expect(result.yamlFragment).toContain("dependsOn:");
  });

  it("detects cycles in decomposed issues", async () => {
    const cyclicOutput = JSON.stringify({
      issues: [
        { slug: "a", description: "A", dependsOn: ["b"] },
        { slug: "b", description: "B", dependsOn: ["a"] },
      ],
    });
    const deps = makeDeps({
      runCommand: vi.fn(() => cyclicOutput),
    });
    const input: DecomposeInput = {
      featureDescription: "Something cyclic",
    };

    await expect(decompose(input, deps)).rejects.toThrow(/cycle/i);
  });

  it("throws on empty feature description", async () => {
    const deps = makeDeps();
    const input: DecomposeInput = {
      featureDescription: "",
    };

    await expect(decompose(input, deps)).rejects.toThrow(/description/i);
  });

  it("reads additional context from featureFile when provided", async () => {
    const deps = makeDeps({
      readFile: vi.fn(() => "File context content"),
      runCommand: vi.fn(() => validLlmOutput),
    });
    const input: DecomposeInput = {
      featureDescription: "Build auth",
      featureFile: "/path/to/spec.md",
    };

    await decompose(input, deps);

    expect(deps.readFile).toHaveBeenCalledWith("/path/to/spec.md");
    // The prompt should include the file content
    expect(deps.runCommand).toHaveBeenCalledWith(
      expect.stringContaining("File context content"),
    );
  });

  it("fetches GitHub issue description when issueNumber and repo provided", async () => {
    const deps = makeDeps({
      runCommand: vi.fn((cmd: string) => {
        if (cmd.includes("gh issue view")) {
          return "Issue body from GitHub";
        }
        return validLlmOutput;
      }),
    });
    const input: DecomposeInput = {
      featureDescription: "Build auth",
      issueNumber: 42,
      repo: "owner/repo",
    };

    await decompose(input, deps);

    expect(deps.runCommand).toHaveBeenCalledWith(
      "gh issue view 42 --repo owner/repo --json body -q .body",
    );
  });

  it("includes projectContext in prompt when provided", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(() => validLlmOutput),
    });
    const input: DecomposeInput = {
      featureDescription: "Build auth",
      projectContext: "This is a TypeScript project using Express",
    };

    await decompose(input, deps);

    expect(deps.runCommand).toHaveBeenCalledWith(
      expect.stringContaining("This is a TypeScript project using Express"),
    );
  });

  it("handles LLM returning invalid JSON", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(() => "not valid json"),
    });
    const input: DecomposeInput = {
      featureDescription: "Build something",
    };

    await expect(decompose(input, deps)).rejects.toThrow(/parse/i);
  });

  it("handles LLM returning JSON without issues array", async () => {
    const deps = makeDeps({
      runCommand: vi.fn(() => JSON.stringify({ foo: "bar" })),
    });
    const input: DecomposeInput = {
      featureDescription: "Build something",
    };

    await expect(decompose(input, deps)).rejects.toThrow(/issues/i);
  });
});
