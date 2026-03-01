import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "./types.js";

export type { RunRecord } from "./types.js";

export function writeRunRecord(configDir: string, record: RunRecord): void {
  const runsDir = path.join(configDir, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const filePath = path.join(runsDir, `${record.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
}

export function listRuns(configDir: string): RunRecord[] {
  const runsDir = path.join(configDir, "runs");

  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }

  const records: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const content = fs.readFileSync(path.join(runsDir, entry), "utf-8");
      records.push(JSON.parse(content) as RunRecord);
    } catch {
      console.warn(`Skipping malformed run record: ${entry}`);
    }
  }

  records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return records;
}
