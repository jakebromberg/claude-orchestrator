import { describe, it, expect } from "vitest";
import { isModeNode, isCommandNode, MODE_NODE_KINDS } from "../src/mode-node.js";

describe("mode-node classification", () => {
  describe("isModeNode", () => {
    it.each(MODE_NODE_KINDS)("is true for the recognized mode %s", (mode) => {
      expect(isModeNode({ mode })).toBe(true);
    });

    it("is false when mode is unset (a normal Claude node)", () => {
      expect(isModeNode({})).toBe(false);
      expect(isModeNode({ mode: undefined })).toBe(false);
    });

    it("is false for an unrecognized mode string", () => {
      expect(isModeNode({ mode: "implement" })).toBe(false);
      expect(isModeNode({ mode: "" })).toBe(false);
    });

    it("exposes exactly deploy, publish, gate", () => {
      expect([...MODE_NODE_KINDS]).toEqual(["deploy", "publish", "gate"]);
    });
  });

  describe("isCommandNode", () => {
    it("is true for a mode-node with a non-empty command", () => {
      expect(isCommandNode({ mode: "deploy", command: "gh workflow run deploy.yml" })).toBe(true);
    });

    it("is false for a mode-node without a command", () => {
      expect(isCommandNode({ mode: "gate" })).toBe(false);
      expect(isCommandNode({ mode: "deploy", command: "" })).toBe(false);
    });

    it("is false for a normal node even if it somehow carries a command", () => {
      expect(isCommandNode({ command: "echo hi" })).toBe(false);
      expect(isCommandNode({ mode: undefined, command: "echo hi" })).toBe(false);
    });
  });
});
