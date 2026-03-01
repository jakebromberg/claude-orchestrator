import type { Issue, IssueSpec } from "./types.js";

/**
 * Compute wave assignments from dependency declarations using topological sort.
 *
 * Issues with no dependencies get wave 1. Others get `max(wave of deps) + 1`.
 * Throws if the dependency graph contains a cycle.
 */
export function computeWaves(specs: IssueSpec[]): Issue[] {
  if (specs.length === 0) return [];

  const byNumber = new Map<number, IssueSpec>();
  for (const spec of specs) {
    byNumber.set(spec.number, spec);
  }

  // Build adjacency: for each issue, track which issues depend on it
  const dependents = new Map<number, number[]>();
  const inDegree = new Map<number, number>();

  for (const spec of specs) {
    dependents.set(spec.number, []);
    inDegree.set(spec.number, spec.dependsOn.length);
  }

  for (const spec of specs) {
    for (const dep of spec.dependsOn) {
      dependents.get(dep)?.push(spec.number);
    }
  }

  // Kahn's algorithm: process nodes with in-degree 0, compute waves
  const waves = new Map<number, number>();
  const queue: number[] = [];

  for (const spec of specs) {
    if (spec.dependsOn.length === 0) {
      queue.push(spec.number);
      waves.set(spec.number, 1);
    }
  }

  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;

    const currentWave = waves.get(current)!;

    for (const dependent of dependents.get(current) ?? []) {
      // Update wave: max of all dependency waves + 1
      const existingWave = waves.get(dependent) ?? 0;
      waves.set(dependent, Math.max(existingWave, currentWave + 1));

      // Decrement in-degree
      const remaining = inDegree.get(dependent)! - 1;
      inDegree.set(dependent, remaining);

      if (remaining === 0) {
        queue.push(dependent);
      }
    }
  }

  if (processed < specs.length) {
    const inCycle = specs
      .filter((s) => !waves.has(s.number) || inDegree.get(s.number)! > 0)
      .map((s) => `#${s.number}`)
      .join(", ");
    throw new Error(`Dependency cycle detected among issues: ${inCycle}`);
  }

  return specs.map((spec) => ({
    ...spec,
    wave: waves.get(spec.number)!,
    deps: spec.dependsOn,
  }));
}
