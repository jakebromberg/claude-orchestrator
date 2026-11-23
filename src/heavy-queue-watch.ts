/**
 * `heavy-queue watch`: a live, full-screen view of the machine-wide lease that redraws every interval until SIGINT or SIGTERM.
 * It reads the same view `status` prints (`statusView`) and takes no mutex, ticket or holder; like `status`, a read may refresh the shared pressure reading and the unowned-memory cache when they are stale.
 */

import type { StatusView } from "./lease-run.js";

const GB = 1024 ** 3;
const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR_TO_END = "\x1b[J";

export interface WatchArgs {
  kind: "watch";
  /** Seconds between redraws; always finite and above 0. */
  intervalSec: number;
}

/** Redraws come no faster than this, so a watch never spins. */
export const MIN_WATCH_INTERVAL_SEC = 0.1;
/** The longest interval a Node timer holds; past it Node fires every 1 ms. */
export const MAX_WATCH_INTERVAL_SEC = Math.floor(2_147_483_647 / 1000);

export interface RenderOptions {
  now: Date;
  /** Columns available; every line is cut to it. */
  width: number;
  /** Rows available; a taller frame is cut to it, its last row saying how many lines are hidden. Absent, no limit. */
  height?: number;
  /** Lease warnings, each shown under the header. */
  notes?: readonly string[];
  /** IANA zone for the header clock; absent, the process's own. */
  timeZone?: string;
}

/** What `runWatch` needs from the process, injectable for tests. */
export interface WatchDeps {
  /** Reads the lease; a throw is drawn as `status unavailable` and the watch goes on. */
  status(): StatusView;
  now(): Date;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(fn: () => void, ms: number): () => void;
  write(text: string): void;
  /** When false, frames are written plain and whole, one after another, with no escape codes. */
  isTTY: boolean;
  columns(): number;
  rows(): number;
  /** The lease warnings collected so far, each once. */
  notes(): readonly string[];
  /** Calls `fn` once when the watch should end (Ctrl-C, SIGTERM, a closed output); returns the unsubscribe. */
  onStop(fn: () => void): () => void;
  timeZone?: string;
}

const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;

/** `m:ss` under an hour, `h:mm:ss` from an hour. */
function age(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number) => String(n).padStart(2, "0");
  const [h, m, r] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function clock(now: Date, timeZone: string | undefined): string {
  return now.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short", ...(timeZone && { timeZone }) });
}

/** Control characters (a newline in a `--shell` command, an escape sequence) become spaces, so a cell stays on one line and writes no raw bytes. */
const oneLine = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/**
 * The program's name in a `ps command=` line: the text before the first argument (whitespace followed by `-` or `/`), then its last path piece.
 * A heuristic: a program path with spaces keeps them, and a bare argument that is not a flag or a path stays in the name.
 */
function programName(command: string): string {
  const program = command.trim().split(/\s+(?=[-/])/)[0] ?? "";
  return program.split("/").at(-1) || command;
}

/** Pads every column but the last to its widest cell, two spaces apart, each row indented two spaces. */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2))).join("")}`.trimEnd());
}

/** Draws one frame of the queue, or the read error in place of the tables. */
export function renderQueue(view: StatusView | Error, o: RenderOptions): string {
  const time = clock(o.now, o.timeZone);
  const notes = (o.notes ?? []).map((n) => `! ${oneLine(n)}`);
  const body = view instanceof Error ? ["", `status unavailable: ${oneLine(view.message)}`] : frameLines(view);
  const head = `heavy queue  ${time}${view instanceof Error ? "" : headline(view)}`;
  let lines = [head, ...notes, ...body];
  if (o.height !== undefined && lines.length > o.height) {
    const keep = Math.max(0, o.height - 1);
    lines = [...lines.slice(0, keep), `… ${lines.length - keep} more lines`];
  }
  return lines.map((l) => l.slice(0, Math.max(1, o.width))).join("\n");
}

function headline(v: StatusView): string {
  const w = v.weights;
  const memory = w ? `  memory ${gb(w.used)} / ${gb(w.budget)} budget${w.free ? ` (free ${gb(w.free.freeBytes)}, reserve ${gb(w.free.reserve)})` : ""}` : "";
  return `  level ${v.level}  capacity ${v.capacity}${memory}`;
}

function frameLines(v: StatusView): string[] {
  const out = ["", `RUNNING (${v.live.length})`];
  if (v.live.length === 0) out.push("  nothing running");
  else out.push(...table([["PID", "AGE", "PRI", "STATE", "COMMAND"], ...v.live.map((h) => [String(h.pid), age(h.ageSec), h.priority ?? "normal", h.suspended ? "SUSPENDED" : "running", oneLine(h.command)])]));
  const waiting = v.waiting ?? [];
  out.push("", `WAITING (${waiting.length})`);
  if (waiting.length === 0) out.push("  nothing waiting");
  else out.push(...table([["#", "SEQ", "PRI", "GATE", "LABEL"], ...waiting.map((t, i) => [String(i + 1), String(t.seq), t.priority ?? "normal", gate(t), oneLine(t.label)])]));
  if (v.unowned) {
    const u = v.unowned;
    const others = u.others.map((p) => `  ${oneLine(programName(p.command))} (${p.pid}) ${gb(p.bytes)}`).join("");
    out.push("", `UNOWNED  claude ${gb(u.claude)}  simulators ${gb(u.simulators)}${others}`);
  }
  return out;
}

/** `ready` is absent on a ticket from a build that predates it, so its gate is unknown rather than blocked. */
function gate(t: NonNullable<StatusView["waiting"]>[number]): string {
  if (!t.gated) return "ungated";
  return t.ready === undefined ? "unknown" : t.ready ? "ready" : "blocked";
}

/** Redraws the queue every `intervalSec` until `onStop` fires, then restores the screen and resolves 0. A terminal frame is cut one column short of the width (so the last column never wraps) and to the rows; a plain frame is whole. */
export function runWatch(args: Pick<WatchArgs, "intervalSec">, d: WatchDeps): Promise<number> {
  const draw = (): void => {
    let view: StatusView | Error;
    try {
      view = d.status();
    } catch (e) {
      view = e instanceof Error ? e : new Error(String(e));
    }
    const fit = d.isTTY ? { width: d.columns() - 1, height: d.rows() } : { width: Infinity };
    const frame = renderQueue(view, { now: d.now(), ...fit, notes: d.notes(), ...(d.timeZone && { timeZone: d.timeZone }) });
    d.write(d.isTTY ? `${HOME}${frame.replaceAll("\n", `\x1b[K\n`)}\x1b[K${CLEAR_TO_END}` : `${frame}\n\n`);
  };
  return new Promise((resolve) => {
    if (d.isTTY) d.write(ENTER_SCREEN);
    draw();
    const cancel = d.every(draw, args.intervalSec * 1000);
    let unsubscribe = (): void => {};
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      cancel();
      unsubscribe();
      if (d.isTTY) d.write(LEAVE_SCREEN);
      resolve(0);
    };
    unsubscribe = d.onStop(stop);
  });
}
