import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHeavyQueueArgs, runHeavyQueue } from "../src/cli-heavy-queue.js";
import { acquireLease, type LeaseHandle, type LeaseOptions, type LeaseRefusal } from "../src/lease.js";
import { cliLeaseDeps, runStatus, type LeaseCliDeps } from "../src/lease-run.js";
import { plantHolder, scriptedLease, type ScriptedLease } from "./helpers/lease.js";

const FRONT_END = { gated: true, background: true, suspendable: true, uncapped: true };

describe("parseHeavyQueueArgs", () => {
  it.each<[string, string[], unknown]>([
    ["status", ["status"], { kind: "status" }],
    ["--label, then --shell", ["run", "--label", "s: lint", "--shell", "npm run lint && npm test"], { kind: "run", label: "s: lint", shell: "npm run lint && npm test", ...FRONT_END }],
    ["--label, then -- argv", ["run", "--label", "s: t", "--", "npm", "test"], { kind: "run", label: "s: t", argv: ["npm", "test"], ...FRONT_END }],
    ["--no-suspend after the label", ["run", "--label", "x", "--no-suspend", "--", "make"], { kind: "run", label: "x", argv: ["make"], noSuspend: true, ...FRONT_END }],
    ["no label", ["run", "--", "make"], { kind: "run", label: "unlabelled", argv: ["make"], ...FRONT_END }],
    ["a second -- belongs to the command", ["run", "--", "npm", "test", "--", "--bail"], { kind: "run", label: "unlabelled", argv: ["npm", "test", "--", "--bail"], ...FRONT_END }],
  ])("parses %s", (_name, argv, expected) => {
    expect(parseHeavyQueueArgs(argv)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["no arguments", []],
    ["an unknown subcommand", ["bogus"]],
    ["run with no command", ["run"]],
    ["nothing after --", ["run", "--"]],
    ["--shell with extra arguments", ["run", "--shell", "a", "b"]],
    ["--shell with no command", ["run", "--shell"]],
    ["--label with no value", ["run", "--label"]],
    ["--no-suspend before --label", ["run", "--no-suspend", "--label", "x", "--", "make"]],
    ["an unknown flag", ["run", "--max-wait", "5", "--", "make"]],
  ])("rejects %s", (_name, argv) => {
    expect(parseHeavyQueueArgs(argv)).toBeUndefined();
  });
});

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
  pid = 4321;
}

describe("runHeavyQueue", () => {
  let tmp: string;
  let lease: ScriptedLease;
  let err: string[];
  let out: string[];
  let child: FakeChild;
  let spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[];
  let ticks: (() => void)[];
  let cancelled: number;

  const deps = (over: Partial<LeaseCliDeps> = {}, env: NodeJS.ProcessEnv = {}): LeaseCliDeps => ({
    ...cliLeaseDeps((l) => err.push(l), { env }),
    leaseOptions: () => lease.opts(),
    ancestors: () => [],
    spawn: (file, args, o) => (spawned.push({ file, args, env: o.env }), child),
    governor: { every: (fn) => (ticks.push(fn), () => void cancelled++) },
    env,
    cwd: tmp,
    out: (t) => out.push(t),
    signals: Object.assign(new EventEmitter(), { pid: 999, kill: vi.fn() }),
    ...over,
  });
  /** Lets the run get through the lease and spawn, then ends the child. */
  const finishWith = async (code: number): Promise<void> => {
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    child.emit("close", code, null);
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cli-heavy-queue-"));
    lease = scriptedLease(join(tmp, "lease"));
    err = [];
    out = [];
    spawned = [];
    ticks = [];
    cancelled = 0;
    child = new FakeChild();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  describe("exit codes", () => {
    it.each(["", "bogus", "run", "run --shell a b"])("exits 2 with the usage on %j and takes no slot", async (line) => {
      expect(await runHeavyQueue(line.split(" ").filter(Boolean), deps())).toBe(2);
      expect(err.join("\n")).toMatch(/usage: heavy-queue run --label/);
      expect(existsSync(lease.dir)).toBe(false);
    });

    it.each([0, 3, 255])("returns the command's exit code %i", async (code) => {
      const done = runHeavyQueue(["run", "--label", "x", "--", "npm", "test"], deps());
      await finishWith(code);
      expect(await done).toBe(code);
    });

    it("exits 74 on disk full and 78 on a misconfigured lease, and never 75", async () => {
      const refuse = (r: LeaseRefusal) => deps({ acquire: (async () => r) as unknown as typeof acquireLease });
      const full: LeaseRefusal = { refused: "disk-full", waitedMs: 0, level: "normal", live: 0, code: "ENOSPC" };
      expect(await runHeavyQueue(["run", "--", "make"], refuse(full))).toBe(74);
      const bad = deps({ leaseOptions: () => { throw new Error("CO_LEASE_DIR must be absolute"); } });
      expect(await runHeavyQueue(["run", "--", "make"], bad)).toBe(78);
      expect(await runHeavyQueue(["status"], bad)).toBe(78);
    });
  });

  describe("parity with heavy-queue", () => {
    it("runs under taskpolicy -b in its own group (heavy-queue's taskpolicy)", async () => {
      const done = runHeavyQueue(["run", "--label", "x", "--shell", "npm test"], deps());
      await finishWith(0);
      await done;
      expect(spawned[0]).toMatchObject({ file: "/usr/sbin/taskpolicy", args: ["-b", "/bin/sh", "-c", "npm test"] });
    });

    it("gates the ticket, marks the holder suspendable and schedules the governor tick", async () => {
      const metas: unknown[] = [];
      const acquire = (async (o: LeaseOptions, m: unknown, w: { maxWaitMs?: number }) => (metas.push([m, w.maxWaitMs]), acquireLease(o, m as never, w))) as typeof acquireLease;
      const done = runHeavyQueue(["run", "--label", "x", "--", "sleep", "100"], deps({ acquire }));
      await finishWith(0);
      await done;
      expect(metas[0]).toMatchObject([{ label: "x", gated: true, suspendable: true }, undefined]);
      expect(ticks).toHaveLength(1);
      expect(cancelled).toBe(1);
    });

    it.each<[string, string[], NodeJS.ProcessEnv]>([
      ["--no-suspend", ["run", "--no-suspend", "--", "sleep", "100"], {}],
      ["HEAVY_QUEUE_NO_SUSPEND=1", ["run", "--", "sleep", "100"], { HEAVY_QUEUE_NO_SUSPEND: "1" }],
      ["a never-suspend command", ["run", "--", "docker", "build", "."], {}],
    ])("does not mark the holder suspendable under %s", async (_n, argv, env) => {
      const metas: Record<string, unknown>[] = [];
      const acquire = (async (o: LeaseOptions, m: Record<string, unknown>, w: never) => (metas.push(m), acquireLease(o, m as never, w))) as unknown as typeof acquireLease;
      const done = runHeavyQueue(argv, deps({ acquire }, env));
      await finishWith(0);
      await done;
      expect(metas[0]).not.toHaveProperty("suspendable", true);
      expect(ticks).toEqual([]);
    });

    it("ignores CO_LEASE_MAX_WAIT, HEAVY_QUEUE_STATE and HEAVY_QUEUE_METRICS", async () => {
      const waits: unknown[] = [];
      const acquire = (async (o: LeaseOptions, m: never, w: { maxWaitMs?: number }) => (waits.push(w.maxWaitMs), acquireLease(o, m, w))) as typeof acquireLease;
      const env = { CO_LEASE_MAX_WAIT: "5", HEAVY_QUEUE_STATE: join(tmp, "state"), HEAVY_QUEUE_METRICS: join(tmp, "metrics") };
      const done = runHeavyQueue(["run", "--", "make"], deps({ acquire }, env));
      await finishWith(0);
      await done;
      expect(waits).toEqual([undefined]);
      expect(err.join("\n")).not.toMatch(/CO_LEASE_MAX_WAIT/);
      expect(existsSync(join(tmp, "state")) || existsSync(join(tmp, "metrics"))).toBe(false);
    });
  });

  describe("waiting", () => {
    it("waits past 100 s in one line, holding no slot, and then runs the command", async () => {
      plantHolder(lease, "other", { pid: 4242 });
      lease.alive.add(4242);
      const seen: { tickets: string[]; holders: string[] }[] = [];
      lease.clock.onSleep = () => {
        seen.push({ tickets: readdirSync(join(lease.dir, "waiting")), holders: readdirSync(join(lease.dir, "holders")) });
        // Beat the planted holder's heartbeat until 250 s have passed, then release its slot.
        const file = join(lease.dir, "holders", "other.json");
        if (lease.clock.ms - start > 250_000) rmSync(file);
        else utimesSync(file, lease.clock.ms / 1000, lease.clock.ms / 1000);
      };
      const start = lease.clock.ms;
      const done = runHeavyQueue(["run", "--label", "x", "--", "make"], deps());
      await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 5000 });
      child.emit("close", 0, null);
      expect(await done).toBe(0);
      expect(lease.clock.ms - start).toBeGreaterThan(100_000);
      expect(seen.length).toBeGreaterThan(1);
      for (const s of seen.slice(0, -1)) expect(s).toEqual({ tickets: [expect.stringMatching(/\.json$/)], holders: ["other.json"] });
      expect(err.filter((l) => l.startsWith("lease: waiting"))).not.toEqual([]);
    });
  });

  describe("status", () => {
    it("prints what the lease's status prints, and no more", async () => {
      plantHolder(lease, "a", { pid: 4242, command: "make", suspended: true });
      lease.alive.add(4242);
      const d = deps();
      expect(await runHeavyQueue(["status"], d)).toBe(0);
      const viaFrontEnd = out.join("");
      out.length = 0;
      expect(runStatus(d)).toBe(0);
      expect(viaFrontEnd).toBe(out.join(""));
      expect(JSON.parse(viaFrontEnd).live).toEqual([expect.objectContaining({ command: "make", suspended: true })]);
    });
  });
});

describe("package bin", () => {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));

  it("declares claude-orchestrator-heavy-queue, and package-lock.json's root bin agrees", () => {
    expect(read("package.json").bin["claude-orchestrator-heavy-queue"]).toBe("dist/src/cli-heavy-queue.js");
    expect(read("package-lock.json").packages[""].bin).toEqual(read("package.json").bin);
  });
});
