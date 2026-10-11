import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  sessionCapacity,
  stopAtCritical,
  type PressureLevel,
} from "../src/memory-pressure.js";
import * as barrel from "../src/index.js";

const policy = { heavyCeiling: 4, heavyWarning: 1 };
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
  it.each([
    [{ CO_LEASE_DIR: "/a", XDG_STATE_HOME: "/x", HOME: "/h" }, "/a"],
    [{ XDG_STATE_HOME: "/x", HOME: "/h" }, "/x/claude-orchestrator/lease"],
    [{ HOME: "/h" }, "/h/.local/state/claude-orchestrator/lease"],
  ])("resolves %j to %s", (env, expected) => {
    expect(leaseDirectory(env)).toBe(expected);
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

  it("returns the reading and persists the raw level atomically", () => {
    reading = "warning";
    expect(make()()).toBe("warning");
    expect(persisted()).toEqual({ level: "warning", at: t });
    expect(readdirSync(dir)).toEqual(["level.json"]);
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

    it("uses a fresh in-process reading", () => {
      const s = make();
      s();
      t += 59_000;
      expect(fail(s)).toBe("normal");
      expect(log).toHaveBeenCalledTimes(1);
      fail(s);
      expect(log).toHaveBeenCalledTimes(1);
    });

    it("reads critical once the in-process reading is stale", () => {
      const s = make();
      s();
      t += 60_000;
      expect(fail(s)).toBe("critical");
    });

    it.each([
      ["fresh", 59_000, "warning"],
      ["stale", 60_000, "critical"],
    ])("a %s persisted level.json -> %s", (_n, age, expected) => {
      writeFileSync(join(dir, "level.json"), JSON.stringify({ level: "warning", at: t - age }));
      expect(fail(make())).toBe(expected);
    });

    it.each([
      ["missing file", undefined],
      ["corrupt file", "{not json"],
      ["bad level", JSON.stringify({ level: "bogus", at: 1_000_000 })],
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
