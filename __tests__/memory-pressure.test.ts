import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPressureOverride,
  cachedPressureSampler,
  defaultPressureSampler,
  heavyCapacity,
  leaseDirectory,
  pressurePolicyFromEnv,
  readMemoryPressure,
  readMemorySignals,
  sessionCapacity,
  stopAtCritical,
  type PressureLevel,
} from "../src/memory-pressure.js";
import * as barrel from "../src/index.js";

const policy = { heavyCeiling: 4, heavyWarning: 1, sessionCeiling: 6 };
const LEVELS: PressureLevel[] = ["normal", "warning", "critical", "unknown"];

describe("readMemoryPressure", () => {
  it.each([
    ["1\n", "normal"],
    ["2", "warning"],
    ["4\n", "critical"],
    ["3", null],
    ["", null],
    ["garbage", null],
  ])("maps darwin sysctl output %j to %j", (out, expected) => {
    const sysctl = vi.fn(() => out);
    expect(readMemoryPressure({ platform: "darwin", sysctl })).toBe(expected);
    expect(sysctl).toHaveBeenCalledWith("kern.memorystatus_vm_pressure_level");
  });

  it("returns null when the darwin read throws or times out", () => {
    const sysctl = () => {
      throw new Error("ETIMEDOUT");
    };
    expect(readMemoryPressure({ platform: "darwin", sysctl })).toBeNull();
  });

  it("returns unknown without calling sysctl on other platforms", () => {
    const sysctl = vi.fn(() => "4");
    expect(readMemoryPressure({ platform: "linux", sysctl })).toBe("unknown");
    expect(sysctl).not.toHaveBeenCalled();
  });
});

describe("readMemorySignals", () => {
  const GUARDED = ["kern.memorystatus_vm_pressure_level", "kern.memorystatus_level"];
  const SWAP = ["vm.compressor.swapper.used_bytes", "vm.compressor.swapper.allocated_bytes", "vm.compressor.swapper.swapins_total"];
  const reply = (guarded: string | Error, swap: string | Error) => (...names: string[]): string => {
    const out = names[0] === GUARDED[0] ? guarded : swap;
    if (out instanceof Error) throw out;
    return out;
  };

  it("reads the two guarded names in one call and the swap names in a separate one", () => {
    const sysctl = vi.fn(reply("2\n41\n", "8258519040\n9663676416\n12\n"));
    expect(readMemorySignals({ platform: "darwin", sysctl })).toEqual({
      level: "warning",
      freePct: 41,
      swapUsedBytes: 8258519040,
      swapAllocatedBytes: 9663676416,
      swapinsTotal: 12,
    });
    expect(sysctl.mock.calls).toEqual([GUARDED, SWAP]);
  });

  it.each([
    ["a throw", new Error("ETIMEDOUT")],
    ["an unrecognised level", "3\n41\n"],
    ["a missing free percentage", "1\n"],
    ["an unparseable free percentage", "1\nabc\n"],
    ["a free percentage over 100", "1\n101\n"],
    ["empty output", ""],
  ])("returns null on %s from the guarded read", (_name, guarded) => {
    expect(readMemorySignals({ platform: "darwin", sysctl: reply(guarded, "1\n2\n3\n") })).toBeNull();
  });

  it.each([
    ["a throw (a renamed oid)", new Error("unknown oid")],
    ["empty output", ""],
    ["unparseable values", "x\ny\nz\n"],
  ])("leaves the swap fields absent and the guarded values intact on %s from the optional read", (_name, swap) => {
    expect(readMemorySignals({ platform: "darwin", sysctl: reply("1\n59\n", swap) })).toEqual({ level: "normal", freePct: 59 });
  });

  it("keeps the swap values that parse when others do not", () => {
    expect(readMemorySignals({ platform: "darwin", sysctl: reply("1\n59\n", "5\n\n7\n") })).toEqual({
      level: "normal",
      freePct: 59,
      swapUsedBytes: 5,
      swapinsTotal: 7,
    });
  });

  it("reports unknown without calling sysctl on other platforms", () => {
    const sysctl = vi.fn(() => "1");
    expect(readMemorySignals({ platform: "linux", sysctl })).toEqual({ level: "unknown" });
    expect(sysctl).not.toHaveBeenCalled();
  });
});

describe("capacity tables", () => {
  it.each([
    ["normal", 4],
    ["unknown", 4],
    ["warning", 1],
    ["critical", 0],
  ] as const)("heavyCapacity(%s) = %d", (level, expected) => {
    expect(heavyCapacity(level, policy)).toBe(expected);
  });

  it("heavyCapacity honours a custom policy but critical stays 0", () => {
    const p = { heavyCeiling: 7, heavyWarning: 2 };
    expect(heavyCapacity("normal", p)).toBe(7);
    expect(heavyCapacity("warning", p)).toBe(2);
    expect(heavyCapacity("critical", p)).toBe(0);
  });

  it.each([
    ["normal", 6],
    ["unknown", 6],
    ["warning", 1],
    ["critical", 0],
  ] as const)("sessionCapacity(%s, 6) = %d", (level, expected) => {
    expect(sessionCapacity(level, 6)).toBe(expected);
  });

  it.each(LEVELS.flatMap((l) => [0, 1, 3].map((r) => [l, r] as const)))(
    "stopAtCritical(%s, running=%d) is true only for critical with nothing running",
    (level, running) => {
      expect(stopAtCritical(level, running)).toBe(level === "critical" && running === 0);
    },
  );
});

describe("pressurePolicyFromEnv", () => {
  it("defaults to ceiling 4 and warning 1", () => {
    expect(pressurePolicyFromEnv({}, vi.fn())).toEqual(policy);
  });

  it("CO_LEASE_SLOTS overrides the ceiling", () => {
    expect(pressurePolicyFromEnv({ CO_LEASE_SLOTS: "6" }, vi.fn()).heavyCeiling).toBe(6);
  });

  it.each(["0", "-1", "abc", "2.5", ""])("keeps the default and reports for invalid %j", (v) => {
    const warn = vi.fn();
    expect(pressurePolicyFromEnv({ CO_LEASE_SLOTS: v }, warn)).toEqual(policy);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("CO_LEASE_SESSION_SLOTS overrides the session ceiling and leaves the heavy policy alone", () => {
    expect(pressurePolicyFromEnv({ CO_LEASE_SESSION_SLOTS: " 3 ", CO_LEASE_SLOTS: "2" }, vi.fn())).toEqual({ heavyCeiling: 2, heavyWarning: 1, sessionCeiling: 3 });
  });

  it.each(["0", "-1", "abc", "2.5", ""])("keeps the session default and reports for invalid CO_LEASE_SESSION_SLOTS %j", (v) => {
    const warn = vi.fn();
    expect(pressurePolicyFromEnv({ CO_LEASE_SESSION_SLOTS: v }, warn)).toEqual(policy);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("CO_LEASE_SESSION_SLOTS");
  });
});

describe("cachedPressureSampler", () => {
  it("caches within the ttl, expires at it, and fresh() bypasses and refreshes", () => {
    let t = 0;
    const levels: PressureLevel[] = ["normal", "warning", "critical", "normal"];
    const read = vi.fn(() => levels.shift()!);
    const s = cachedPressureSampler(read, undefined, () => t);
    expect(s()).toBe("normal");
    t = 9_999;
    expect(s()).toBe("normal");
    expect(read).toHaveBeenCalledTimes(1);
    t = 10_000;
    expect(s()).toBe("warning");
    expect(read).toHaveBeenCalledTimes(2);
    expect(s.fresh()).toBe("critical");
    expect(s()).toBe("critical");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("honours a custom ttl", () => {
    let t = 0;
    const read = vi.fn((): PressureLevel => "normal");
    const s = cachedPressureSampler(read, 100, () => t);
    s();
    t = 100;
    s();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("treats a cached level from the future (a backward clock step) as expired", () => {
    let t = 3_600_000;
    const levels: PressureLevel[] = ["normal", "critical"];
    const read = vi.fn(() => levels.shift()!);
    const s = cachedPressureSampler(read, undefined, () => t);
    expect(s()).toBe("normal");
    t = 0;
    expect(s()).toBe("critical");
    t = 9_999;
    expect(s()).toBe("critical");
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("applyPressureOverride", () => {
  it.each(LEVELS)("maps only critical with the exact value (%s)", (level) => {
    const warn = vi.fn();
    const out = applyPressureOverride(level, { CO_PRESSURE_OVERRIDE: "critical-as-warning" }, warn);
    expect(out).toBe(level === "critical" ? "warning" : level);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is a no-op when unset", () => {
    const warn = vi.fn();
    expect(applyPressureOverride("critical", {}, warn)).toBe("critical");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["Critical-As-Warning", "warning", "1", ""])("ignores %j with a warning", (v) => {
    const warn = vi.fn();
    expect(applyPressureOverride("critical", { CO_PRESSURE_OVERRIDE: v }, warn)).toBe("critical");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("leaseDirectory", () => {
  const accountHome = () => "/u";

  it.each([
    [{ CO_LEASE_DIR: "/a", XDG_STATE_HOME: "/x", HOME: "/h" }, "/a"],
    [{ XDG_STATE_HOME: "/x", HOME: "/h" }, "/x/claude-orchestrator/lease"],
    [{ HOME: "/h" }, "/h/.local/state/claude-orchestrator/lease"],
    [{ XDG_STATE_HOME: "", HOME: "/h" }, "/h/.local/state/claude-orchestrator/lease"],
    [{ XDG_STATE_HOME: "rel", HOME: "/h" }, "/h/.local/state/claude-orchestrator/lease"],
    [{}, "/u/.local/state/claude-orchestrator/lease"],
    [{ HOME: "" }, "/u/.local/state/claude-orchestrator/lease"],
    [{ HOME: "rel" }, "/u/.local/state/claude-orchestrator/lease"],
    [{ XDG_STATE_HOME: "rel" }, "/u/.local/state/claude-orchestrator/lease"],
  ])("resolves %j to %s", (env, expected) => {
    expect(leaseDirectory(env, accountHome)).toBe(expected);
  });

  it.each(["", "rel"])("throws instead of resolving against the cwd when the account home is %j", (home) => {
    expect(() => leaseDirectory({}, () => home)).toThrow(/lease directory/);
  });

  it.each(["rel/lease", ".", "./lease"])("throws instead of resolving against the cwd when CO_LEASE_DIR is %j", (dir) => {
    expect(() => leaseDirectory({ CO_LEASE_DIR: dir, HOME: "/h" }, accountHome)).toThrow(/CO_LEASE_DIR/);
  });
});

describe("defaultPressureSampler", () => {
  let dir: string;
  let t: number;
  let env: NodeJS.ProcessEnv;
  let log: ReturnType<typeof vi.fn>;
  let reading: PressureLevel | null;
  const make = (e = env) => defaultPressureSampler(e, { read: () => reading, now: () => t, log });
  const persisted = () => JSON.parse(readFileSync(join(dir, "level.json"), "utf8"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mp-"));
    env = { CO_LEASE_DIR: dir };
    t = 1_000_000;
    reading = "normal";
    log = vi.fn();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns the reading and persists the raw level", () => {
    reading = "warning";
    expect(make()()).toBe("warning");
    expect(persisted()).toEqual({ level: "warning", at: t });
    expect(readdirSync(dir)).toEqual(["level.json"]);
  });

  it("replaces level.json by renaming a temp file onto it, never by writing it in place", () => {
    const s = make();
    s();
    const before = statSync(join(dir, "level.json")).ino;
    reading = "warning";
    t += 1;
    s.fresh();
    expect(persisted()).toEqual({ level: "warning", at: t });
    // A write in place keeps the inode; only a rename onto the path gives it a new one.
    expect(statSync(join(dir, "level.json")).ino).not.toBe(before);
    expect(readdirSync(dir)).toEqual(["level.json"]);
  });

  it("does not write level.json through a symlinked lease directory", () => {
    const real = mkdtempSync(join(tmpdir(), "mp-real-"));
    const link = join(dir, "link");
    symlinkSync(real, link);
    try {
      expect(make({ CO_LEASE_DIR: link })()).toBe("normal");
      expect(readdirSync(real)).toEqual([]);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("routes an invalid CO_PRESSURE_OVERRIDE warning to the injected log, never to stderr, and tells each writer once", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const bad = { ...env, CO_PRESSURE_OVERRIDE: "nope" };
      const first = vi.fn();
      const second = vi.fn();
      const a = defaultPressureSampler(bad, { read: () => reading, now: () => t, log: first });
      const b = defaultPressureSampler(bad, { read: () => reading, now: () => t, log: second });
      a();
      a.fresh();
      b();
      b.fresh();
      expect(first).toHaveBeenCalledTimes(1);
      expect(first).toHaveBeenCalledWith(expect.stringContaining("CO_PRESSURE_OVERRIDE"));
      expect(second).toHaveBeenCalledTimes(1);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("words a read failure without its own tag, so a writer's 'memory-pressure:' prefix does not stutter", () => {
    const s = make();
    reading = null as unknown as PressureLevel;
    expect(s()).toBe("critical");
    expect(log).toHaveBeenCalledWith("read failed; using the last good reading, else critical");
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^memory-pressure/));
  });

  it("persists the raw level, not the overridden one", () => {
    reading = "critical";
    const s = make({ ...env, CO_PRESSURE_OVERRIDE: "critical-as-warning" });
    expect(s()).toBe("warning");
    expect(persisted().level).toBe("critical");
    expect(log).toHaveBeenCalledTimes(1);
    s.fresh();
    expect(log).toHaveBeenCalledTimes(1);
  });

  describe("overridden()", () => {
    const overrideEnv = () => ({ ...env, CO_PRESSURE_OVERRIDE: "critical-as-warning" });

    it.each([
      ["critical", true, "warning", true],
      ["warning", true, "warning", false],
      ["normal", true, "normal", false],
      ["critical", false, "critical", false],
    ] as const)("raw %s with override=%s reads %s, overridden=%s", (raw, override, level, wasOverridden) => {
      reading = raw;
      const s = make(override ? overrideEnv() : env);
      expect(s()).toBe(level);
      expect(s.overridden?.()).toBe(wasOverridden);
      expect(persisted().level).toBe(raw);
      expect(readdirSync(dir)).toEqual(["level.json"]);
    });

    it("follows the last reading, and logs only when a reading is mapped", () => {
      reading = "warning";
      const s = make(overrideEnv());
      s();
      expect(log).not.toHaveBeenCalled();
      reading = "critical";
      s.fresh();
      expect(s.overridden?.()).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      reading = "normal";
      s.fresh();
      expect(s.overridden?.()).toBe(false);
    });
  });

  it("does not create a missing lease directory", () => {
    const missing = join(dir, "nope");
    make({ CO_LEASE_DIR: missing })();
    expect(existsSync(missing)).toBe(false);
  });

  describe("read-failure fallback", () => {
    const fail = (s: ReturnType<typeof make>) => {
      reading = null;
      return s.fresh();
    };

    // Each row sets both sources explicitly: the in-process reading is "normal" and
    // level.json holds "warning", so the result names the source that served it. An
    // age is how long before the failed read a reading was taken; a negative age is a
    // reading from the future (a backward clock step, or a skewed or hand-edited file).
    it.each([
      ["a fresh in-process reading", "normal", 59_000, undefined],
      ["a stale in-process reading", "critical", 60_000, undefined],
      ["an in-process reading from the future", "critical", -1, undefined],
      ["a fresh level.json", "warning", undefined, 59_000],
      ["a level.json from this instant", "warning", undefined, 0],
      ["a stale level.json", "critical", undefined, 60_000],
      ["a level.json from the future", "critical", undefined, -1],
      ["no reading at all", "critical", undefined, undefined],
      ["a fresh in-process reading ahead of a fresh level.json", "normal", 1_000, 1_000],
      ["a stale in-process reading, then a fresh level.json", "warning", 60_000, 1_000],
    ] as const)("%s -> %s", (_n, expected, inProcessAge, persistedAge) => {
      const s = make();
      const failAt = t;
      if (inProcessAge !== undefined) {
        t = failAt - inProcessAge;
        s();
        rmSync(join(dir, "level.json"));
      }
      if (persistedAge !== undefined) {
        writeFileSync(join(dir, "level.json"), JSON.stringify({ level: "warning", at: failAt - persistedAge }));
      }
      t = failAt;
      expect(fail(s)).toBe(expected);
    });

    it("logs the fallback once", () => {
      const s = make();
      fail(s);
      fail(s);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["missing file", undefined],
      ["corrupt file", "{not json"],
      ["bad level", JSON.stringify({ level: "bogus", at: 1_000_000 })],
      ["missing at", JSON.stringify({ level: "warning" })],
      ["string at", JSON.stringify({ level: "warning", at: "1000000" })],
      ["far-future at", JSON.stringify({ level: "warning", at: 9e15 })],
    ])("%s -> critical", (_n, content) => {
      if (content !== undefined) writeFileSync(join(dir, "level.json"), content);
      expect(fail(make())).toBe("critical");
    });

    it("never persists a failed read", () => {
      fail(make());
      expect(existsSync(join(dir, "level.json"))).toBe(false);
    });

    it("applies the override to the fallback too", () => {
      const s = make({ ...env, CO_PRESSURE_OVERRIDE: "critical-as-warning" });
      expect(fail(s)).toBe("warning");
    });
  });
});

describe("index exports", () => {
  it.each([
    "readMemoryPressure",
    "heavyCapacity",
    "sessionCapacity",
    "stopAtCritical",
    "pressurePolicyFromEnv",
    "cachedPressureSampler",
    "applyPressureOverride",
    "defaultPressureSampler",
    "leaseDirectory",
  ])("exports %s", (name) => {
    expect(typeof (barrel as Record<string, unknown>)[name]).toBe("function");
  });
});
