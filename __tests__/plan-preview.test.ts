import { describe, it, expect } from "vitest";
import { refOf, normalizeDep } from "../src/ref.js";
import { renderPlanPreview } from "../src/plan-preview.js";
import type { Issue } from "../src/types.js";

function makeIssue(
  overrides: Omit<Partial<Issue>, "deps"> & { deps?: (number | string)[] } = {},
): Issue {
  const { deps: depOverride, ref: refOverride, ...rest } = overrides;
  const base = {
    number: 1,
    slug: "test-issue",
    wave: 1,
    dependsOn: [],
    description: "Test issue",
    ...rest,
  };
  return {
    ...base,
    ref: refOverride ?? refOf(base),
    deps: (depOverride ?? []).map((d) => normalizeDep(d, base)),
  };
}

describe("renderPlanPreview", () => {
  it("prints a header with the config name and issue/wave counts", () => {
    const out = renderPlanPreview({
      name: "bs-1819",
      issues: [
        makeIssue({ number: 1, wave: 1 }),
        makeIssue({ number: 2, wave: 2, dependsOn: [1], deps: [1] }),
      ],
    });
    expect(out).toContain("bs-1819");
    expect(out).toContain("2 issues");
    expect(out).toContain("2 waves");
  });

  it("renders an empty config without throwing", () => {
    const out = renderPlanPreview({ name: "empty", issues: [] });
    expect(out).toContain("empty");
    expect(out).toContain("0 issues");
    expect(out).toContain("0 waves");
    expect(out).toContain("0 HITL gates");
    expect(out).not.toContain("Wave 1");
    expect(out).not.toContain("HITL cutover gates");
  });

  it("singularizes counts of one", () => {
    const out = renderPlanPreview({
      name: "solo",
      issues: [makeIssue({ number: 1, wave: 1 })],
    });
    expect(out).toContain("1 issue");
    expect(out).toContain("1 wave");
    expect(out).not.toContain("1 issues");
    expect(out).not.toContain("1 waves");
  });

  it("groups issues under their wave with the slug and ref", () => {
    const out = renderPlanPreview({
      name: "grouped",
      issues: [
        makeIssue({ number: 924, slug: "reserve-headroom", repo: "WXYC/library-metadata-lookup", wave: 1 }),
        makeIssue({ number: 929, slug: "protect-local-search", repo: "WXYC/library-metadata-lookup", wave: 2 }),
      ],
    });
    expect(out).toContain("Wave 1");
    expect(out).toContain("Wave 2");
    expect(out).toContain("WXYC/library-metadata-lookup#924");
    expect(out).toContain("reserve-headroom");
    expect(out).toContain("WXYC/library-metadata-lookup#929");
  });

  it("shows the resolved model/effort for a plain Claude issue", () => {
    const out = renderPlanPreview({
      name: "me",
      issues: [makeIssue({ number: 1, complexity: "complex" })],
    });
    // complexity "complex" -> high; default model sonnet
    expect(out).toContain("sonnet/high");
  });

  it("honors a per-issue model override in the model/effort display", () => {
    const out = renderPlanPreview({
      name: "me",
      issues: [makeIssue({ number: 1, model: "opus", complexity: "mechanical" })],
    });
    expect(out).toContain("opus/low");
  });

  it("falls back to config-level defaultModel/defaultEffort", () => {
    const out = renderPlanPreview({
      name: "me",
      defaultModel: "haiku",
      defaultEffort: "low",
      issues: [makeIssue({ number: 1 })],
    });
    expect(out).toContain("haiku/low");
  });

  it("renders a command mode-node with its kind and command, not model/effort", () => {
    const out = renderPlanPreview({
      name: "deploy",
      issues: [
        makeIssue({
          number: 9001,
          slug: "deploy-lml",
          repo: "WXYC/library-metadata-lookup",
          mode: "deploy",
          command: "gh workflow run deploy.yml -R WXYC/library-metadata-lookup",
          wave: 1,
        }),
      ],
    });
    expect(out).toContain("[deploy]");
    expect(out).toContain("gh workflow run deploy.yml -R WXYC/library-metadata-lookup");
    expect(out).not.toContain("sonnet/");
    expect(out).toContain("1 mode-node");
  });

  it("renders a command-less manual gate and flags it as a cutover", () => {
    const out = renderPlanPreview({
      name: "gate",
      issues: [
        makeIssue({ number: 9002, slug: "wait-canary", mode: "gate", wave: 1 }),
      ],
    });
    expect(out).toContain("[gate]");
    expect(out).toContain("manual gate");
    expect(out).toContain("1 HITL gate");
    expect(out).toContain("HITL cutover gates");
  });

  it("flags a bare cross-repo dependency as a HITL cutover gate", () => {
    const upstream = makeIssue({
      number: 82,
      slug: "canary-verify",
      repo: "WXYC/wxyc-canary",
      wave: 1,
    });
    const downstream = makeIssue({
      number: 685,
      slug: "ios-consume",
      repo: "WXYC/wxyc-ios-64",
      wave: 2,
      deps: ["WXYC/wxyc-canary#82"],
    });
    const out = renderPlanPreview({
      name: "xrepo",
      issues: [upstream, downstream],
    });
    expect(out).toContain("HITL cutover gates");
    expect(out).toContain("cross-repo dependency WXYC/wxyc-canary#82");
    // the gated issue is the ios one, not the canary upstream
    expect(out).toMatch(/WXYC\/wxyc-ios-64#685[^\n]*(⚠|HITL)/);
  });

  it("does not gate a cross-repo dependency that is itself a mode-node", () => {
    const deploy = makeIssue({
      number: 9001,
      slug: "deploy-lml",
      repo: "WXYC/library-metadata-lookup",
      mode: "deploy",
      command: "echo deploy",
      wave: 1,
    });
    const canary = makeIssue({
      number: 82,
      slug: "canary",
      repo: "WXYC/wxyc-canary",
      wave: 2,
      deps: ["WXYC/library-metadata-lookup#9001"],
    });
    const out = renderPlanPreview({ name: "d", issues: [deploy, canary] });
    // deploy is a manual-less command node, so no gate is introduced by the edge
    expect(out).toContain("0 HITL gates");
    expect(out).not.toContain("HITL cutover gates");
  });

  it("lists each issue's dependencies as refs", () => {
    const out = renderPlanPreview({
      name: "deps",
      issues: [
        makeIssue({ number: 926, slug: "adr", repo: "WXYC/library-metadata-lookup", wave: 1 }),
        makeIssue({
          number: 929,
          slug: "impl",
          repo: "WXYC/library-metadata-lookup",
          wave: 2,
          deps: [926],
        }),
      ],
    });
    expect(out).toContain("WXYC/library-metadata-lookup#926");
    // the dependent lists its dep ref
    expect(out).toMatch(/WXYC\/library-metadata-lookup#929[\s\S]*WXYC\/library-metadata-lookup#926/);
  });

  it("keeps colliding numbers in different repos as distinct rows", () => {
    const out = renderPlanPreview({
      name: "collide",
      issues: [
        makeIssue({ number: 924, slug: "lml-924", repo: "WXYC/library-metadata-lookup", wave: 1 }),
        makeIssue({ number: 924, slug: "bs-924", repo: "WXYC/Backend-Service", wave: 1 }),
      ],
    });
    expect(out).toContain("WXYC/library-metadata-lookup#924");
    expect(out).toContain("WXYC/Backend-Service#924");
    expect(out).toContain("lml-924");
    expect(out).toContain("bs-924");
  });

  it("orders issues within a wave deterministically by repo then number", () => {
    const out = renderPlanPreview({
      name: "order",
      issues: [
        makeIssue({ number: 10, slug: "b", repo: "WXYC/library-metadata-lookup", wave: 1 }),
        makeIssue({ number: 9, slug: "a", repo: "WXYC/library-metadata-lookup", wave: 1 }),
      ],
    });
    expect(out.indexOf("#9")).toBeLessThan(out.indexOf("#10"));
  });
});
