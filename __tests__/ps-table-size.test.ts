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

// Issue #324 review: the default UI-test scan reads the environment of a simulator xctest it cannot place from its path, to tell a leftover from a test in
// progress; the reader bounds its `ps -E` call the same way and any failure leaves the process counted.
describe("the default UI-test scan and a simulator xctest", () => {
  const U = "5E2F590B-1111-4222-8333-444455556666";
  const XCODE = "/Applications/Xcode.app/Contents/MacOS/Xcode";
  const XCTEST = "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest -XCTestBundlePath x";
  let tmp: string;
  const table = (): string =>
    psText([
      { pid: 100, ppid: 1, pgid: 100, uid, command: XCODE },
      { pid: 200, ppid: 1, pgid: 200, uid, command: XCTEST },
    ]);
  const scan = () => defaultLeaseOptions({ CO_LEASE_DIR: join(tmp, "lease") }, { level: scriptedPressureSampler("normal") }).scanUiTests!();
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ps-env-"));
    exec.mockReset();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("reads the environment of the xctest with one bounded ps call and does not count it when its device has no launchd_sim", () => {
    exec.mockImplementation(((_file: string, args: string[]) => (args.includes("-Eww") ? `200 ${XCTEST} SIMULATOR_UDID=${U} HOME=/x\n` : table())) as never);
    expect(scan()).toEqual([]);
    const envCalls = exec.mock.calls.filter((c) => (c[1] as string[]).includes("-Eww"));
    expect(envCalls).toHaveLength(1);
    expect(envCalls[0]![1]).toEqual(["-Eww", "-p", "200", "-o", "pid=,command="]);
    expect((envCalls[0]![2] as { maxBuffer: number; timeout: number }).maxBuffer).toBeGreaterThanOrEqual(64 * MIB);
    expect((envCalls[0]![2] as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  it("keeps counting it when the environment read fails, times out or names no device", () => {
    for (const env of [() => { throw Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" }); }, () => `200 ${XCTEST} HOME=/x\n`, () => ""]) {
      exec.mockReset();
      exec.mockImplementation(((_file: string, args: string[]) => (args.includes("-Eww") ? env() : table())) as never);
      expect(scan()).toEqual([200]);
    }
  });

  it("uses the rows of a ps that exits 1 because a listed pid is gone", () => {
    exec.mockImplementation(((_file: string, args: string[]) => {
      if (!args.includes("-Eww")) return table();
      throw Object.assign(new Error("exit 1"), { status: 1, stdout: `200 ${XCTEST} SIMULATOR_UDID=${U} HOME=/x\n` });
    }) as never);
    expect(scan()).toEqual([]);
  });

  it("asks for nothing when no candidate needs it", () => {
    exec.mockImplementation((() => psText([{ pid: 200, ppid: 1, pgid: 200, uid, command: "xcodebuild test -scheme A" }])) as never);
    expect(scan()).toEqual([200]);
    expect(exec.mock.calls.filter((c) => (c[1] as string[]).includes("-Eww"))).toEqual([]);
  });
});
