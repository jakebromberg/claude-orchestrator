import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDetachSpawnCommand,
  buildGhIssueCreateCommand,
  buildNotificationScript,
  findScriptPackageRoot,
} from "../src/create-main.js";

describe("buildGhIssueCreateCommand", () => {
  it("produces a well-formed gh issue create command", () => {
    expect(buildGhIssueCreateCommand("owner/repo", "my-feature")).toBe(
      "gh issue create --repo 'owner/repo' --title 'my-feature' --body-file -",
    );
  });

  it("shell-quotes repo with spaces", () => {
    expect(buildGhIssueCreateCommand("owner/my repo", "slug")).toBe(
      "gh issue create --repo 'owner/my repo' --title 'slug' --body-file -",
    );
  });

  it("shell-quotes title containing single quote", () => {
    expect(buildGhIssueCreateCommand("owner/repo", "Jake's feature")).toBe(
      "gh issue create --repo 'owner/repo' --title 'Jake'\\''s feature' --body-file -",
    );
  });

  it("shell-quotes title containing dollar sign and backtick", () => {
    expect(buildGhIssueCreateCommand("owner/repo", "$title`name`")).toBe(
      "gh issue create --repo 'owner/repo' --title '$title`name`' --body-file -",
    );
  });
});

describe("buildNotificationScript", () => {
  it("produces valid AppleScript for a plain name", () => {
    expect(buildNotificationScript("My Project", "3 succeeded, 1 failed")).toBe(
      'display notification "3 succeeded, 1 failed" with title "My Project"',
    );
  });

  it("escapes double quotes in name using AppleScript string concatenation", () => {
    expect(buildNotificationScript('Project "X"', "1 succeeded, 0 failed")).toBe(
      'display notification "1 succeeded, 0 failed" with title "Project " & quote & "X" & quote & ""',
    );
  });

  it("passes single quotes, dollar signs, and backticks through unchanged", () => {
    // These are safe because execFileSync passes args without shell expansion.
    expect(buildNotificationScript("Jake's $project`s`", "2 succeeded, 0 failed")).toBe(
      "display notification \"2 succeeded, 0 failed\" with title \"Jake's $project`s`\"",
    );
  });

  it("handles name with only special characters", () => {
    expect(buildNotificationScript("$`'", "0 succeeded, 1 failed")).toBe(
      "display notification \"0 succeeded, 1 failed\" with title \"$`'\"",
    );
  });
});

describe("buildDetachSpawnCommand", () => {
  // The detach respawn runs in a fresh process. When the consumer's entry
  // point is a TypeScript file, plain `node` will fail to resolve `.js`
  // imports that point at `.ts` files. Route through `npx tsx` so the
  // consumer's tsx (declared in its node_modules) handles loader duties.
  // Compiled `.js` consumers stay on `node` so they don't pay the npx
  // round-trip on every detach.

  const NODE = "/usr/bin/node";

  it("uses node directly for compiled .js script paths", () => {
    expect(
      buildDetachSpawnCommand({
        scriptPath: "/repo/dist/main.js",
        configName: "my-config",
        childArgv: ["--parallel", "4"],
        nodeExecPath: NODE,
        findPackageRoot: () => "/repo",
      }),
    ).toEqual({
      command: NODE,
      args: ["/repo/dist/main.js", "my-config", "--parallel", "4"],
    });
  });

  it("routes .ts script paths through `npx --prefix <pkgRoot> tsx`", () => {
    expect(
      buildDetachSpawnCommand({
        scriptPath: "/repo/scripts/orchestrator/src/main.ts",
        configName: "ios-wave-2c",
        childArgv: ["--parallel", "4", "--notify"],
        nodeExecPath: NODE,
        findPackageRoot: () => "/repo/scripts/orchestrator",
      }),
    ).toEqual({
      command: "npx",
      args: [
        "--prefix",
        "/repo/scripts/orchestrator",
        "tsx",
        "/repo/scripts/orchestrator/src/main.ts",
        "ios-wave-2c",
        "--parallel",
        "4",
        "--notify",
      ],
    });
  });

  it.each([".ts", ".mts", ".cts", ".tsx"])(
    "treats %s as TypeScript",
    (ext) => {
      const result = buildDetachSpawnCommand({
        scriptPath: `/repo/main${ext}`,
        configName: "c",
        childArgv: [],
        nodeExecPath: NODE,
        findPackageRoot: () => "/repo",
      });
      expect(result.command).toBe("npx");
      expect(result.args).toContain("tsx");
    },
  );

  it.each([".js", ".mjs", ".cjs"])(
    "treats %s as plain JavaScript",
    (ext) => {
      const result = buildDetachSpawnCommand({
        scriptPath: `/repo/main${ext}`,
        configName: "c",
        childArgv: [],
        nodeExecPath: NODE,
        findPackageRoot: () => "/repo",
      });
      expect(result.command).toBe(NODE);
      expect(result.args[0]).toBe(`/repo/main${ext}`);
    },
  );

  it("omits --prefix when no package root is found (npx falls back to cwd resolution)", () => {
    expect(
      buildDetachSpawnCommand({
        scriptPath: "/tmp/scratch.ts",
        configName: "c",
        childArgv: [],
        nodeExecPath: NODE,
        findPackageRoot: () => null,
      }),
    ).toEqual({
      command: "npx",
      args: ["tsx", "/tmp/scratch.ts", "c"],
    });
  });

  it("passes through all childArgv tokens verbatim", () => {
    const result = buildDetachSpawnCommand({
      scriptPath: "/r/m.ts",
      configName: "c",
      childArgv: ["--parallel", "4", "--notify", "--wave", "2"],
      nodeExecPath: NODE,
      findPackageRoot: () => "/r",
    });
    expect(result.args.slice(-5)).toEqual([
      "--parallel",
      "4",
      "--notify",
      "--wave",
      "2",
    ]);
  });

  it("recognizes TypeScript regardless of extension case (TS, MTS, etc.)", () => {
    const result = buildDetachSpawnCommand({
      scriptPath: "/r/Main.TS",
      configName: "c",
      childArgv: [],
      nodeExecPath: NODE,
      findPackageRoot: () => "/r",
    });
    expect(result.command).toBe("npx");
  });
});

describe("findScriptPackageRoot", () => {
  // Walks up from the script's directory toward the filesystem root, returning
  // the first ancestor with a package.json. Used by --detach to pin
  // `npx --prefix` at the consumer's package, so tsx is resolved from the
  // consumer's node_modules.

  it("returns the directory containing package.json closest to the script", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "find-pkg-root-"));
    try {
      const pkgDir = path.join(tmp, "scripts", "orchestrator");
      fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "package.json"), "{}");
      const scriptPath = path.join(pkgDir, "src", "main.ts");
      fs.writeFileSync(scriptPath, "");

      expect(findScriptPackageRoot(scriptPath)).toBe(pkgDir);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers the nearest package.json over outer ones (monorepo case)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "find-pkg-root-"));
    try {
      fs.writeFileSync(path.join(tmp, "package.json"), "{}");
      const innerPkg = path.join(tmp, "packages", "engine");
      fs.mkdirSync(path.join(innerPkg, "src"), { recursive: true });
      fs.writeFileSync(path.join(innerPkg, "package.json"), "{}");
      const scriptPath = path.join(innerPkg, "src", "main.ts");
      fs.writeFileSync(scriptPath, "");

      expect(findScriptPackageRoot(scriptPath)).toBe(innerPkg);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when no package.json exists between the script and the filesystem root", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "find-pkg-root-"));
    try {
      const scriptPath = path.join(tmp, "deep", "nest", "main.ts");
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, "");

      expect(findScriptPackageRoot(scriptPath)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
