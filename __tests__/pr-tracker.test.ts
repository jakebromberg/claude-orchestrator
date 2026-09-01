import { describe, it, expect } from "vitest";
import { extractPrUrl, repoOfPrUrl } from "../src/pr-tracker.js";

describe("extractPrUrl", () => {
  it("extracts PR URL from typical log output", () => {
    const log = `Creating PR...
https://github.com/daisysguide/launchpad/pull/95
Done.`;
    const result = extractPrUrl(log);
    expect(result).toEqual({
      url: "https://github.com/daisysguide/launchpad/pull/95",
      number: 95,
    });
  });

  it("extracts last PR URL when multiple are present", () => {
    const log = `PR created: https://github.com/org/repo/pull/10
See also: https://github.com/org/repo/pull/20`;
    const result = extractPrUrl(log);
    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/20",
      number: 20,
    });
  });

  it("skips test fixture URLs and finds real PR URL", () => {
    const log = `Running tests with fixture https://github.com/org/repo/pull/1
All tests passed.
Created PR: https://github.com/daisysguide/launchpad/pull/106`;
    const result = extractPrUrl(log);
    expect(result).toEqual({
      url: "https://github.com/daisysguide/launchpad/pull/106",
      number: 106,
    });
  });

  it("returns null when no PR URL found", () => {
    const log = "No PR was created in this session.";
    expect(extractPrUrl(log)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractPrUrl("")).toBeNull();
  });

  it("extracts from URL embedded in JSON output", () => {
    const log = `{"type":"result","url":"https://github.com/daisysguide/frontend/pull/42","status":"merged"}`;
    const result = extractPrUrl(log);
    expect(result).toEqual({
      url: "https://github.com/daisysguide/frontend/pull/42",
      number: 42,
    });
  });

  it("handles URLs with org names containing hyphens", () => {
    const log = "https://github.com/my-org/my-repo/pull/123";
    const result = extractPrUrl(log);
    expect(result).toEqual({
      url: "https://github.com/my-org/my-repo/pull/123",
      number: 123,
    });
  });

  it("does not match issue URLs", () => {
    const log = "https://github.com/org/repo/issues/5";
    expect(extractPrUrl(log)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Own-repo constraint
  // -------------------------------------------------------------------------
  //
  // Regression: WXYC/wxyc-dj-ios#145 was recorded as having produced
  // https://github.com/WXYC/wxyc-shared/pull/358 — a PR that had merged two
  // weeks earlier in a *different* repo. The session opened no PR at all; every
  // one of the four PR URLs in its 3.9 MB transcript was that same foreign one,
  // echoed back by an Edit tool_result that quoted the repo's CLAUDE.md. With
  // nothing to distinguish "a PR URL" from "this run's PR URL", last-match-wins
  // returned it and the run reported green against someone else's work.

  const FOREIGN_PR_TRANSCRIPT = [
    `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01LBD1NpBRA9dJC2CiQsfDAV","type":"tool_result","content":"The file /w/wxyc-dj-ios/CLAUDE.md has been updated successfully.\\n\\n**\`CalendarDate.swift\` is the one entry that is not openapi-generator output.** It is hand-authored upstream at \`wxyc-shared\`'s \`openapi-config/swift-support/CalendarDate.swift\` and copied into the generator's \`Infrastructure/\` by that repo's \`postgenerate:swift\` hook ([wxyc-shared#358](https://github.com/WXYC/wxyc-shared/pull/358))."}]}}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"Documented the keep-list rationale in CLAUDE.md."}`,
  ].join("\n");

  it("ignores a foreign-repo PR URL quoted in the transcript", () => {
    expect(extractPrUrl(FOREIGN_PR_TRANSCRIPT, "WXYC/wxyc-dj-ios")).toBeNull();
  });

  it("returns the issue's own PR even when a foreign one appears later", () => {
    const log = `Created PR: https://github.com/WXYC/wxyc-dj-ios/pull/152
${FOREIGN_PR_TRANSCRIPT}`;
    expect(extractPrUrl(log, "WXYC/wxyc-dj-ios")).toEqual({
      url: "https://github.com/WXYC/wxyc-dj-ios/pull/152",
      number: 152,
    });
  });

  it("still takes the last own-repo match when several are present", () => {
    // The fixture-URL defence above still applies *within* the issue's repo:
    // an `org/repo/pull/1` quoted by a test fixture must not beat the real PR.
    const log = `Running tests with fixture https://github.com/org/repo/pull/1
Created PR: https://github.com/org/repo/pull/106`;
    expect(extractPrUrl(log, "org/repo")).toEqual({
      url: "https://github.com/org/repo/pull/106",
      number: 106,
    });
  });

  it("matches owner/repo case-insensitively", () => {
    // GitHub treats owner/repo as case-insensitive, and a config's `repo` need
    // not match the casing a session happened to print.
    const log = "Created PR: https://github.com/WXYC/wxyc-dj-ios/pull/152";
    expect(extractPrUrl(log, "wxyc/WXYC-DJ-IOS")).toEqual({
      url: "https://github.com/WXYC/wxyc-dj-ios/pull/152",
      number: 152,
    });
  });

  it("does not treat a repo name as a prefix match", () => {
    const log = "https://github.com/org/repo-fork/pull/7";
    expect(extractPrUrl(log, "org/repo")).toBeNull();
  });
});

describe("repoOfPrUrl", () => {
  it("returns the owner/repo of a PR URL", () => {
    expect(repoOfPrUrl("https://github.com/WXYC/wxyc-shared/pull/358")).toBe(
      "WXYC/wxyc-shared",
    );
  });

  it("returns null for a non-PR URL", () => {
    expect(repoOfPrUrl("https://github.com/org/repo/issues/5")).toBeNull();
  });
});
