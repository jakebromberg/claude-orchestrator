import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/** Every src module reachable from `entry` through runtime relative imports and re-exports (`import type` is erased, so it is skipped), entry included. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+"\.\/([\w-]+)\.js"/gm)) visit(`${m[1]}.ts`);
  };
  visit(entry);
  return seen;
}

describe("watchdog import graph", () => {
  it.each(["lease.ts", "headroom-sampler.ts", "lease-events.ts"])("does not reach %s", (mod) => {
    const graph = reachable("watchdog.ts");
    expect(graph.has("engine-registry.ts")).toBe(true);
    expect(graph.has(mod)).toBe(false);
  });
});
