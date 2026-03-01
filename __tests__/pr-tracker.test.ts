import { describe, it, expect } from "vitest";
import { extractPrUrl } from "../src/pr-tracker.js";

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
});
