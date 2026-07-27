import { describe, it, expect } from "vitest";
import {
  resolveModelEffort,
  modelEffortArgs,
  extraDirsArgs,
  modelEffortInputs,
  perIssueSpawnArgs,
  EFFORT_LADDER,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
} from "../src/model-effort.js";

describe("resolveModelEffort", () => {
  describe("model resolution", () => {
    it("defaults to Sonnet when nothing is set", () => {
      expect(resolveModelEffort({})).toEqual({ model: "sonnet", effort: "medium" });
    });

    it("uses config defaultModel when the issue sets no model", () => {
      expect(resolveModelEffort({ defaultModel: "opus" }).model).toBe("opus");
    });

    it("per-issue model overrides the config default", () => {
      expect(resolveModelEffort({ model: "opus", defaultModel: "sonnet" }).model).toBe("opus");
    });

    it("DEFAULT_MODEL / DEFAULT_EFFORT are Sonnet / medium (the intended new baseline)", () => {
      expect(DEFAULT_MODEL).toBe("sonnet");
      expect(DEFAULT_EFFORT).toBe("medium");
    });
  });

  describe("effort by complexity", () => {
    it.each([
      ["mechanical", "low"],
      ["normal", "medium"],
      ["complex", "high"],
    ] as const)("complexity %s -> effort %s", (complexity, effort) => {
      expect(resolveModelEffort({ complexity }).effort).toBe(effort);
    });

    it("unknown complexity falls through to the default effort", () => {
      // (schema normally rejects this; the pure fn is defensive)
      expect(resolveModelEffort({ complexity: "bananas" }).effort).toBe("medium");
    });

    it("explicit per-issue effort beats the complexity mapping", () => {
      expect(resolveModelEffort({ complexity: "mechanical", effort: "max" }).effort).toBe("max");
    });

    it("config defaultEffort applies when neither effort nor complexity is set", () => {
      expect(resolveModelEffort({ defaultEffort: "high" }).effort).toBe("high");
    });

    it("complexity beats config defaultEffort", () => {
      expect(resolveModelEffort({ complexity: "mechanical", defaultEffort: "high" }).effort).toBe("low");
    });
  });

  describe("retry escalation", () => {
    it("attempt 0 / undefined does not escalate", () => {
      expect(resolveModelEffort({ complexity: "normal", retryAttempt: 0 }).effort).toBe("medium");
      expect(resolveModelEffort({ complexity: "normal" }).effort).toBe("medium");
    });

    it("bumps one tier per attempt, cumulatively", () => {
      expect(resolveModelEffort({ complexity: "normal", retryAttempt: 1 }).effort).toBe("high");
      expect(resolveModelEffort({ complexity: "normal", retryAttempt: 2 }).effort).toBe("xhigh");
      expect(resolveModelEffort({ complexity: "normal", retryAttempt: 3 }).effort).toBe("max");
    });

    it("caps at max and never overflows the ladder", () => {
      expect(resolveModelEffort({ complexity: "complex", retryAttempt: 10 }).effort).toBe("max");
    });

    it("keeps the model fixed across escalation (Sonnet stays Sonnet)", () => {
      expect(resolveModelEffort({ complexity: "complex", retryAttempt: 5 }).model).toBe("sonnet");
    });

    it("negative attempts are treated as no escalation", () => {
      expect(resolveModelEffort({ complexity: "normal", retryAttempt: -3 }).effort).toBe("medium");
    });
  });

  describe("Haiku guardrail (never high+ effort on a weak model)", () => {
    it("promotes Haiku to Sonnet when effort reaches high", () => {
      expect(resolveModelEffort({ model: "haiku", effort: "high" })).toEqual({
        model: "sonnet",
        effort: "high",
      });
    });

    it.each(["high", "xhigh", "max"] as const)("promotes Haiku at effort %s", (effort) => {
      expect(resolveModelEffort({ model: "haiku", effort }).model).toBe("sonnet");
    });

    it("leaves Haiku alone at low/medium effort", () => {
      expect(resolveModelEffort({ model: "haiku", effort: "low" })).toEqual({ model: "haiku", effort: "low" });
      expect(resolveModelEffort({ model: "haiku", complexity: "normal" })).toEqual({
        model: "haiku",
        effort: "medium",
      });
    });

    it("promotes Haiku when complexity pushes base effort to high", () => {
      expect(resolveModelEffort({ model: "haiku", complexity: "complex" })).toEqual({
        model: "sonnet",
        effort: "high",
      });
    });

    it("promotes Haiku when retry escalation crosses into high", () => {
      // haiku + normal (medium) + 1 retry -> high -> promote
      expect(resolveModelEffort({ model: "haiku", complexity: "normal", retryAttempt: 1 })).toEqual({
        model: "sonnet",
        effort: "high",
      });
    });

    it("detects Haiku from a full model id", () => {
      expect(resolveModelEffort({ model: "claude-haiku-4-5-20251001", effort: "high" }).model).toBe("sonnet");
    });

    it("does not touch Sonnet or Opus at high effort", () => {
      expect(resolveModelEffort({ model: "opus", effort: "max" }).model).toBe("opus");
      expect(resolveModelEffort({ model: "sonnet", effort: "high" }).model).toBe("sonnet");
    });
  });

  describe("table: (complexity, retryAttempt, model) -> {model, effort}", () => {
    it.each([
      // complexity, model, retryAttempt, expectedModel, expectedEffort
      ["mechanical", undefined, 0, "sonnet", "low"],
      ["normal", undefined, 0, "sonnet", "medium"],
      ["complex", undefined, 0, "sonnet", "high"],
      ["complex", "opus", 0, "opus", "high"],
      ["mechanical", "haiku", 0, "haiku", "low"],
      ["complex", "haiku", 0, "sonnet", "high"],
      ["normal", "sonnet", 1, "sonnet", "high"],
      ["complex", "sonnet", 2, "sonnet", "max"],
      ["mechanical", "haiku", 2, "sonnet", "high"],
    ] as const)(
      "(%s, model=%s, retry=%s) -> %s/%s",
      (complexity, model, retryAttempt, expModel, expEffort) => {
        expect(resolveModelEffort({ complexity, model, retryAttempt })).toEqual({
          model: expModel,
          effort: expEffort,
        });
      },
    );
  });
});

describe("modelEffortArgs", () => {
  it("emits --model and --effort", () => {
    expect(modelEffortArgs({ model: "sonnet", effort: "medium" })).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
  });
});

describe("extraDirsArgs", () => {
  it("emits one --add-dir per dir", () => {
    expect(extraDirsArgs(["/a", "/b"])).toEqual(["--add-dir", "/a", "--add-dir", "/b"]);
  });

  it("returns [] for undefined or empty", () => {
    expect(extraDirsArgs()).toEqual([]);
    expect(extraDirsArgs([])).toEqual([]);
  });
});

describe("modelEffortInputs adapter", () => {
  it("lifts fields off an issue + config, threading retryAttempt", () => {
    const issue = { model: "opus", effort: "high", complexity: "complex" };
    const config = { defaultModel: "sonnet", defaultEffort: "low" };
    expect(modelEffortInputs(issue, config, 2)).toEqual({
      model: "opus",
      effort: "high",
      complexity: "complex",
      defaultModel: "sonnet",
      defaultEffort: "low",
      retryAttempt: 2,
    });
  });
});

describe("perIssueSpawnArgs", () => {
  it("combines model/effort with per-issue extra dirs", () => {
    expect(
      perIssueSpawnArgs(
        { complexity: "complex", extraDirs: ["/repo/wxyc-shared"] },
        {},
      ),
    ).toEqual(["--model", "sonnet", "--effort", "high", "--add-dir", "/repo/wxyc-shared"]);
  });

  it("threads the retry attempt into escalation", () => {
    expect(perIssueSpawnArgs({ complexity: "normal" }, {}, 1)).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "high",
    ]);
  });

  it("honors config defaults with no per-issue annotations", () => {
    expect(perIssueSpawnArgs({}, { defaultModel: "opus", defaultEffort: "high" })).toEqual([
      "--model",
      "opus",
      "--effort",
      "high",
    ]);
  });
});

describe("EFFORT_LADDER", () => {
  it("is ordered low -> max", () => {
    expect(EFFORT_LADDER).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
