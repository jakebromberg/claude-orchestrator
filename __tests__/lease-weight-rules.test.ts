import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadWeightTable, normalizeRemote, resolveWeight, weightFor, type GitLookup, type WeightRule } from "../src/lease-weights.js";

const GIB = 2 ** 30;
const git = (toplevel: string | Error, origin: string | Error): GitLookup => ({
  toplevel: () => { if (toplevel instanceof Error) throw toplevel; return toplevel; },
  origin: () => { if (origin instanceof Error) throw origin; return origin; },
});
const down = new Error("git failed");

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:WXYC/Backend-Service.git", "WXYC/Backend-Service"],
    ["https://github.com/WXYC/Backend-Service", "WXYC/Backend-Service"],
    ["https://github.com/WXYC/Backend-Service.git/", "WXYC/Backend-Service"],
    ["ssh://git@github.com/WXYC/Backend-Service.git\n", "WXYC/Backend-Service"],
    ["nonsense", undefined],
  ])("%s -> %s", (url, expected) => expect(normalizeRemote(url)).toBe(expected));
});

describe("resolveWeight", () => {
  const push: WeightRule = { pattern: "^git push", gb: 1 };
  const keyed = (repo: string): WeightRule[] => [{ pattern: "npm test", repo, gb: 8 }, { pattern: "npm test", gb: 2 }];

  // [name, command, table, git, expected GiB]
  it.each<[string, string, WeightRule[], GitLookup, number | undefined]>([
    ["a pattern-only rule", "git push origin HEAD", [push], git(down, down), 1],
    ["gb 1 is 1073741824 bytes", "git push", [push], git(down, down), 1],
    ["no matching rule", "make", [push], git(down, down), undefined],
    ["an empty table", "git push", [], git(down, down), undefined],
    ["the first match wins", "git push", [{ pattern: "push", gb: 3 }, push], git(down, down), 3],
    ["the pattern is case-sensitive and unanchored", "x GIT PUSH", [{ pattern: "git push", gb: 1 }], git(down, down), undefined],
    ["a repo rule by remote, ignoring case and the URL form", "npm test", keyed("wxyc/backend-service"), git("/w", "git@github.com:WXYC/Backend-Service.git"), 8],
    ["a repo rule by toplevel", "npm test", keyed("/w/backend"), git("/w/backend", "git@github.com:a/b.git"), 8],
    ["a repo rule whose repo differs falls to the next rule", "npm test", keyed("WXYC/Backend-Service"), git("/w", "https://github.com/a/b"), 2],
    ["a toplevel failure leaves only repo-less rules", "npm test", keyed("/w/backend"), git(down, "https://github.com/a/b"), 2],
    ["a remote failure leaves only repo-less rules", "npm test", keyed("a/b"), git("/w", down), 2],
    ["a repo rule alone with a failed lookup", "npm test", [keyed("a/b")[0]!], git(down, down), undefined],
  ])("%s", (_name, command, table, lookup, gib) => {
    expect(resolveWeight(command, "/w", table, lookup)).toBe(gib === undefined ? undefined : gib * GIB);
  });

  it("resolves 1 GiB as 1073741824", () => expect(resolveWeight("git push", "/w", [push], git(down, down))).toBe(1073741824));
});

describe("loadWeightTable", () => {
  let tmp: string;
  let warnings: string[];
  const warn = (l: string): void => void warnings.push(l);
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "lease-weights-"));
    warnings = [];
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const file = (text: string): NodeJS.ProcessEnv => {
    writeFileSync(join(tmp, "w.json"), text);
    return { CO_LEASE_WEIGHTS_FILE: join(tmp, "w.json") };
  };

  it("reads the rules of CO_LEASE_WEIGHTS_FILE", () => {
    expect(loadWeightTable(file('[{"pattern":"p","gb":2}]'), warn)).toEqual([{ pattern: "p", gb: 2 }]);
    expect(warnings).toEqual([]);
  });
  it("reads weights.json in the lease directory by default", () => {
    writeFileSync(join(tmp, "weights.json"), '[{"pattern":"p","gb":2}]');
    expect(loadWeightTable({ CO_LEASE_DIR: tmp }, warn)).toHaveLength(1);
  });
  it("is silent for a missing file", () => {
    expect(loadWeightTable({ CO_LEASE_DIR: tmp }, warn)).toEqual([]);
    expect(loadWeightTable({ CO_LEASE_WEIGHTS_FILE: join(tmp, "none.json") }, warn)).toEqual([]);
    expect(warnings).toEqual([]);
  });
  it.each([
    ["malformed JSON", "{nope"],
    ["not an array", '{"pattern":"p","gb":1}'],
  ])("warns once for %s and returns no rules", (_n, text) => {
    expect(loadWeightTable(file(text), warn)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
  it("warns once for any number of bad entries and keeps the good ones", () => {
    const text = JSON.stringify([{ pattern: "(", gb: 1 }, { pattern: "a", gb: 0 }, { pattern: "b" }, 5, { pattern: "ok", gb: 1 }]);
    expect(loadWeightTable(file(text), warn)).toEqual([{ pattern: "ok", gb: 1 }]);
    expect(warnings).toHaveLength(1);
  });
  it("warns once for an unreadable file", () => {
    expect(loadWeightTable({ CO_LEASE_WEIGHTS_FILE: tmp }, warn)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
  it.each<[string, () => void]>([
    ["a symlink", () => (writeFileSync(join(tmp, "elsewhere"), '[{"pattern":"p","gb":2}]'), symlinkSync(join(tmp, "elsewhere"), join(tmp, "weights.json")))],
    ["a directory", () => mkdirSync(join(tmp, "weights.json"))],
    ["another user's file", () => {
      writeFileSync(join(tmp, "weights.json"), '[{"pattern":"p","gb":2}]');
      vi.spyOn(process as Required<NodeJS.Process>, "getuid").mockReturnValue(statSync(tmp).uid + 1);
    }],
  ])("warns once and reads no rules when weights.json in the lease directory is %s", (_n, plant) => {
    plant();
    expect(loadWeightTable({ CO_LEASE_DIR: tmp }, warn)).toEqual([]);
    vi.restoreAllMocks();
    expect(warnings).toEqual([expect.stringContaining("weights.json")]);
  });
  it("weightFor loads and resolves", () => {
    expect(weightFor("git push", "/w", file('[{"pattern":"push","gb":4}]'), warn)).toBe(4 * GIB);
    expect(weightFor("make", "/w", file('[{"pattern":"push","gb":4}]'), warn)).toBeUndefined();
  });
});
