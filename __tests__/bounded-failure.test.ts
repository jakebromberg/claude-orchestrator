import { describe, expect, it } from "vitest";
import { describeBoundedFailure, isTimeoutError } from "../src/sync-budget.js";

const withProps = (message: string, props: object) => Object.assign(new Error(message), props);

describe("describeBoundedFailure", () => {
  it.each([
    ["ETIMEDOUT", withProps("spawnSync ps ETIMEDOUT", { code: "ETIMEDOUT" }), 2000, "timed out at the 2 s bound"],
    ["SIGTERM", withProps("Command failed", { signal: "SIGTERM" }), 10000, "timed out at the 10 s bound"],
    ["multi-line message", new Error("Command failed: git fetch\n  fatal: no remote\n\n"), 10000, "Command failed: git fetch; fatal: no remote"],
    ["non-Error throw", "boom\nbang", 10000, "boom; bang"],
  ])("%s", (_name, err, bound, expected) => {
    expect(describeBoundedFailure(err, bound)).toBe(expected);
  });

  it.each([[null, false], [undefined, false], [new Error("x"), false], [{ code: "ETIMEDOUT" }, true], [{ signal: "SIGTERM" }, true]])(
    "isTimeoutError(%j) is %s",
    (err, expected) => expect(isTimeoutError(err)).toBe(expected),
  );
});
