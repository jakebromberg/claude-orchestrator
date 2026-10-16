/**
 * Cuts the replay fixture from a raw `sample-signals.py` recording: `count` consecutive samples starting at sample `start`, reduced to `{ at, level, freePct }` (`at` in epoch milliseconds). No other recorded field is kept.
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning cut-fixture.ts <recording.jsonl> [start=376] [count=100] > signals-2026-10-14.jsonl
 *
 * The default window opens in `normal`, holds the 2026-10-14 `warning` episode (free memory 32% to 46%, touching the 40% band edge and never reaching 30%) and ends back in `normal`.
 */
import { readFileSync } from "node:fs";

const LEVELS: Record<number, string> = { 1: "normal", 2: "warning", 4: "critical" };

const [path, startArg = "376", countArg = "100"] = process.argv.slice(2);
if (!path) {
  process.stderr.write("usage: cut-fixture.ts <recording.jsonl> [start] [count]\n");
  process.exit(2);
}
const start = Number(startArg);
const count = Number(countArg);

const samples = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
for (const line of samples.slice(start, start + count)) {
  const { at, sysctl } = JSON.parse(line);
  const level = LEVELS[sysctl["kern.memorystatus_vm_pressure_level"]];
  const freePct = sysctl["kern.memorystatus_level"];
  if (!level || !Number.isInteger(freePct)) throw new Error(`unusable sample at ${at}`);
  process.stdout.write(`${JSON.stringify({ at: Math.round(at * 1000), level, freePct })}\n`);
}
