import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { acquireSessionLease, tryAcquireLease, type LeaseHandle, type LeaseOptions } from "../src/lease.js";
import { readSuspensions, writeSuspension } from "../src/suspensions.js";
import { scriptedHeadroomSampler } from "../src/testing.js";
import { failFsCall, plantCpu, plantHolder, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const TICKS = { idle: 1, total: 10 };
const SECOND = 1000;
const DEAD = 4242;
const ALIVE_FRONT_END = 4343;

describe("continuing a dead owner's suspended group", () => {
  let dir: string;
  let lease: ScriptedLease;
  let step: number;
  let kill: MockInstance<typeof process.kill>;
  let commands: Record<number, string | Error>;
  let asked: number[];
  let handle: LeaseHandle | null;

  const opts = (over: Partial<LeaseOptions> = {}): LeaseOptions =>
    lease.opts({
      policy: { heavyCeiling: 4, heavyWarning: 4 },
      cpuTimes: () => TICKS,
      headroom: scriptedHeadroomSampler(() => ({ level: step === 0 ? "critical" : "normal", step, signals: null })),
      processCommand: (pgid) => {
        asked.push(pgid);
        const c = commands[pgid];
        if (c instanceof Error) throw c;
        return c ?? "sleep 100";
      },
      ...over,
    });
  const holderRec = (id: string) => JSON.parse(readFileSync(join(dir, "holders", `${id}.json`), "utf8"));
  /** A suspended holder whose front end `pid` is `DEAD` unless said otherwise, `ageSec` older than the clock. */
  const plant = (id: string, pgid: number, { pid = DEAD, ageSec = 100, leader = "sleep 100" as string | null | false }: { pid?: number; ageSec?: number; leader?: string | null | false } = {}): void => {
    plantHolder(lease, id, { pid, pgid, childPid: pgid, suspended: true, startedAt: lease.clock.ms - ageSec * SECOND });
    if (leader !== false) writeSuspension(dir, { pgid, by: "lease", reason: "CPU 97% busy", at: "2026-10-19T12:00:00.000Z", remindAt: "2026-10-19T14:00:00.000Z", leader });
  };
  const acquire = (): LeaseHandle | null => (handle = tryAcquireLease(opts(), { command: "npm test", cwd: "/w" }));
  const sigconts = (): unknown[] => kill.mock.calls.filter((c) => c[1] === "SIGCONT").map((c) => c[0]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lease-dead-owner-"));
    lease = scriptedLease(dir, { alive: [process.pid, ALIVE_FRONT_END] });
    step = 4;
    commands = {};
    asked = [];
    handle = null;
    plantCpu(lease, 0.1, TICKS);
    const real = process.kill.bind(process);
    // Only group signals are swallowed; `kill(pid, 0)` probes still reach the kernel.
    kill = vi.spyOn(process, "kill").mockImplementation((pid, sig) => (pid < 0 ? true : real(pid, sig)));
  });
  afterEach(() => {
    kill.mockRestore();
    handle?.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("continues the group after the mutex when its leader still runs the recorded command: mark cleared under the mutex, then SIGCONT, record removed, one resume event", () => {
    plant("dead", 7001);
    kill.mockImplementation(() => {
      expect(existsSync(join(dir, ".mutex"))).toBe(false);
      expect(holderRec("dead").suspended).toBeUndefined();
      expect(readSuspensions(dir)).toHaveLength(1);
      return true;
    });
    acquire();
    expect(kill.mock.calls.filter((c) => c[1] === "SIGCONT")).toEqual([[-7001, "SIGCONT"]]);
    expect(asked).toEqual([7001]);
    expect(holderRec("dead").suspended).toBeUndefined();
    expect(readSuspensions(dir)).toEqual([]);
    expect(lease.events.filter((e) => e.type === "resume")).toEqual([{ type: "resume", id: "dead", pgid: 7001, reason: "dead-owner", class: "heavy" }]);
  });

  it("skips every resume gate: step 0 and CPU at 1.0 still continue it", () => {
    plant("dead", 7001);
    step = 0;
    plantCpu(lease, 1, TICKS);
    acquire();
    expect(sigconts()).toEqual([-7001]);
  });

  it("leaves a stopped but alive front end alone: no probe of the leader, no signal, mark kept", () => {
    plant("stopped", 7001, { pid: ALIVE_FRONT_END });
    acquire();
    expect(asked).toEqual([]);
    expect(sigconts()).toEqual([]);
    expect(holderRec("stopped").suspended).toBe(true);
    expect(readSuspensions(dir)).toHaveLength(1);
  });

  it.each<[string, () => void, { leader?: string | null | false }]>([
    ["a leader whose command changed", () => { commands[7001] = "vim notes"; }, {}],
    ["a null leader in the record", () => {}, { leader: null }],
    ["no record", () => {}, { leader: false }],
  ])("sends no SIGCONT for %s, keeps the record and does not look again", (_n, arrange, plantOpts) => {
    plant("dead", 7001, plantOpts);
    arrange();
    acquire();
    expect(sigconts()).toEqual([]);
    expect(readSuspensions(dir).length).toBe(plantOpts.leader === false ? 0 : 1);
    expect(holderRec("dead").suspended).toBeUndefined();
    expect(lease.events.filter((e) => e.type === "resume")).toEqual([]);
    handle?.release();
    asked.length = 0;
    acquire();
    expect(asked).toEqual([]);
  });

  it("keeps the mark and the record when the leader cannot be read, so the next acquire looks again", () => {
    plant("dead", 7001);
    commands[7001] = new Error("ps: timed out");
    acquire();
    expect(sigconts()).toEqual([]);
    expect(readSuspensions(dir)).toHaveLength(1);
    expect(holderRec("dead").suspended).toBe(true);
    handle?.release();
    commands[7001] = "sleep 100";
    acquire();
    expect(asked).toEqual([7001, 7001]);
    expect(sigconts()).toEqual([-7001]);
  });

  it("names the 2 s bound when the leader lookup times out", () => {
    plant("dead", 7001);
    commands[7001] = Object.assign(new Error("spawnSync ps ETIMEDOUT"), { code: "ETIMEDOUT" });
    acquire();
    expect(sigconts()).toEqual([]);
    expect(lease.warnings.at(-1)).toMatch(/could not read the leader of group 7001: timed out at the 2 s bound/);
  });

  it("sends no signal when the record cannot be read, and the orphan stays selectable by a later acquire", () => {
    plant("dead", 7001);
    const restore = failFsCall("openSync", (p) => p.includes("suspensions"), "EIO");
    try {
      acquire();
    } finally {
      restore();
    }
    expect(sigconts()).toEqual([]);
    expect(asked).toEqual([]);
    expect(readSuspensions(dir)).toHaveLength(1);
    expect(holderRec("dead").suspended).toBe(true);
    expect(lease.warnings.at(-1)).toMatch(/could not read the leader of group 7001: EIO/);
    handle?.release();
    acquire();
    expect(sigconts()).toEqual([-7001]);
  });

  it("claims the orphan under the mutex: an acquire made during the leader lookup does not pick it again", () => {
    plant("dead", 7001);
    let nested: LeaseHandle | null = null;
    commands = new Proxy({} as Record<number, string>, {
      get: () => {
        if (!nested) nested = tryAcquireLease(opts(), { command: "npm run lint", cwd: "/w" });
        return "sleep 100";
      },
    });
    acquire();
    nested!.release();
    expect(asked).toEqual([7001]);
    expect(sigconts()).toEqual([-7001]);
  });

  it("leaves an orphan it cannot claim for a later acquire, and admits as usual", () => {
    plant("dead", 7001);
    const restore = failFsCall("renameSync", (p) => p.includes(join("holders", "dead.json.")), "EIO");
    try {
      expect(acquire()).not.toBeNull();
    } finally {
      restore();
    }
    expect(asked).toEqual([]);
    expect(holderRec("dead").suspended).toBe(true);
  });

  it("puts the mark back even while another process holds the mutex, so a later acquire continues the group", () => {
    plant("dead", 7001);
    let failing = true;
    commands = new Proxy({} as Record<number, string | Error>, {
      get: () => {
        if (!failing) return "sleep 100";
        writeFileSync(join(dir, ".mutex"), "someone else");
        return new Error("ps: timed out");
      },
    });
    acquire();
    expect(holderRec("dead").suspended).toBe(true);
    expect(sigconts()).toEqual([]);
    failing = false;
    rmSync(join(dir, ".mutex"));
    handle?.release();
    acquire();
    expect(sigconts()).toEqual([-7001]);
  });

  it("says so when the mark cannot be put back", () => {
    plant("dead", 7001);
    commands[7001] = new Error("ps: timed out");
    // The claim writes before the lookup asks; only the put-back after it fails.
    const restore = failFsCall("renameSync", (p) => p.includes(join("holders", "dead.json.")) && asked.length > 0, "EIO");
    try {
      acquire();
    } finally {
      restore();
    }
    expect(holderRec("dead").suspended).toBeUndefined();
    expect(lease.warnings.at(-1)).toMatch(/could not mark group 7001 for another try: EIO/);
  });

  it("never touches an owner's record or signals for it", () => {
    plantHolder(lease, "dead", { pid: DEAD, pgid: 7001, suspended: true });
    writeSuspension(dir, { pgid: 7001, by: "jake", reason: "mine", at: "2026-10-19T12:00:00.000Z", remindAt: "2026-10-19T14:00:00.000Z", leader: "sleep 100" });
    acquire();
    expect(sigconts()).toEqual([]);
    expect(readSuspensions(dir)).toMatchObject([{ by: "jake" }]);
  });

  it("ignores a suspended holder with no recorded group", () => {
    plantHolder(lease, "dead", { pid: DEAD, suspended: true });
    acquire();
    expect(asked).toEqual([]);
  });

  it("continues at most one group per acquire, the oldest first, and the next acquire takes the other", () => {
    plant("younger", 7002, { ageSec: 50 });
    plant("older", 7001, { ageSec: 100 });
    acquire();
    expect(asked).toEqual([7001]);
    expect(sigconts()).toEqual([-7001]);
    handle?.release();
    acquire();
    expect(asked).toEqual([7001, 7002]);
    expect(sigconts()).toEqual([-7001, -7002]);
  });

  it("is a heavy-class rule: a session acquire continues nothing", async () => {
    plant("dead", 7001);
    const session = (await acquireSessionLease(opts(), { command: "claude", cwd: "/w" })) as LeaseHandle;
    session.release();
    expect(asked).toEqual([]);
    expect(sigconts()).toEqual([]);
  });

  it("does not let a failing SIGCONT change the acquire", () => {
    plant("dead", 7001);
    kill.mockImplementation((pid) => {
      if (pid < 0) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      return true;
    });
    expect(acquire()).not.toBeNull();
    expect(readSuspensions(dir)).toHaveLength(1);
    expect(holderRec("dead").suspended).toBeUndefined();
    expect(lease.warnings.at(-1)).toMatch(/could not continue group 7001: kill EPERM/);
  });
});
