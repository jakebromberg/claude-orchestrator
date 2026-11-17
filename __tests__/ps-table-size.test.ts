import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { psText } from "./helpers/ps-text.js";

// Issue #324 review: `execFileSync` caps stdout at 1 MiB unless told otherwise, and this machine's process table (swift-frontend rows of 13 to 69 KB among
// 1,700 rows) is already over half of that. Past the cap every reader of the table would fail: the UI-test scan would read as unreadable and refuse
// every UI run after 400 s, and the watchdog's scan, and through it the reaper, would skip every cycle. The mock below fails the way node does, so each
// default reader is driven over a table of more than 1 MiB.

const MIB = 1024 * 1024;
const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync: exec }));

const { ps, PS_TABLE_ARGS } = await import("../src/ps.js");
const { scanProcessTable } = await import("../src/watchdog.js");
const { defaultLeaseOptions } = await import("../src/lease.js");
const { realReaperDeps } = await import("../src/simulator-reaper.js");
const { scriptedPressureSampler } = await import("../src/testing.js");

const uid = process.getuid!();
const big = (): string =>
  psText([
    { pid: 100, ppid: 1, pgid: 100, uid, command: `swift-frontend ${"x".repeat(1.2 * MIB)}` },
    { pid: 200, ppid: 1, pgid: 200, uid, command: "xcodebuild test -scheme App" },
    { pid: 300, ppid: 1, pgid: 300, uid, command: "zsh" },
  ]);

describe("every reader of the process table takes more than 1 MiB", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ps-size-"));
    exec.mockReset();
    exec.mockImplementation(((_file: string, _args: string[], options?: { maxBuffer?: number }) => {
      const text = big();
      if (text.length > (options?.maxBuffer ?? MIB)) throw Object.assign(new Error("spawnSync ps ENOBUFS"), { code: "ENOBUFS" });
      return text;
    }) as never);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("ps() reads it, with a buffer of at least 64 MiB", () => {
    expect(ps(PS_TABLE_ARGS, { timeoutMs: 60_000 }).length).toBeGreaterThan(MIB);
    expect((exec.mock.calls[0]![2] as { maxBuffer: number }).maxBuffer).toBeGreaterThanOrEqual(64 * MIB);
  });

  it("the watchdog's scan reads it", () => {
    expect(scanProcessTable().length).toBeGreaterThan(MIB);
  });

  it("the default UI-test scan reads it and finds the test action in it", () => {
    const opts = defaultLeaseOptions({ CO_LEASE_DIR: join(tmp, "lease") }, { level: scriptedPressureSampler("normal") });
    expect(opts.scanUiTests!()).toEqual([200]);
  });

  it("the reaper's default scan reads it", () => {
    const rows = realReaperDeps({ log: () => {}, uid }).scan();
    expect(rows.map((r) => r.pid)).toEqual([100, 200, 300]);
  });
});
