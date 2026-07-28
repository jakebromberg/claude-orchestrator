import { describe, it, expect } from "vitest";
import { readySet, layeredTopoSort, type TopoNode } from "../src/topo.js";

function node(ref: string, deps: string[] = []): TopoNode {
  return { ref, deps };
}

describe("readySet", () => {
  it("returns every dependency-free node as ready", () => {
    const { ready, blockedExternally } = readySet([node("1"), node("2")]);
    expect(ready).toEqual(["1", "2"]);
    expect(blockedExternally).toEqual([]);
  });

  it("holds back a node whose dep is not yet done (held, not blocked)", () => {
    const { ready, blockedExternally } = readySet([node("1", ["2"]), node("2")]);
    expect(ready).toEqual(["2"]);
    // #1 is waiting on an in-scope dep, so it must NOT be reported as externally
    // blocked — it will ship on a later pass once #2 is done.
    expect(blockedExternally).toEqual([]);
  });

  it("releases a node once its dep is in the done frontier", () => {
    const { ready } = readySet([node("1", ["2"])], ["2"]);
    expect(ready).toEqual(["1"]);
  });

  it("omits already-done nodes from ready", () => {
    const { ready } = readySet([node("1"), node("2")], ["1"]);
    expect(ready).toEqual(["2"]);
  });

  it("counts a done dep as met while still flagging a co-located external dep", () => {
    // #1 depends on both #2 (done) and #99 (external). `unmet` filters out the
    // done dep first, so only #99 survives to the external check.
    const { ready, blockedExternally } = readySet([node("1", ["2", "99"])], ["2"]);
    expect(ready).toEqual([]);
    expect(blockedExternally).toEqual([{ ref: "1", missing: ["99"] }]);
  });

  it("flags a node whose dep is neither done nor in scope as blockedExternally", () => {
    const { ready, blockedExternally } = readySet([node("1", ["99"])]);
    expect(ready).toEqual([]);
    expect(blockedExternally).toEqual([{ ref: "1", missing: ["99"] }]);
  });

  it("dedupes repeated missing deps", () => {
    const { blockedExternally } = readySet([node("1", ["99", "99"])]);
    expect(blockedExternally).toEqual([{ ref: "1", missing: ["99"] }]);
  });

  it("preserves input order in the ready list (deterministic)", () => {
    const { ready } = readySet([node("3"), node("1"), node("2")]);
    expect(ready).toEqual(["3", "1", "2"]);
  });
});

describe("layeredTopoSort", () => {
  it("returns empty waves for no nodes", () => {
    expect(layeredTopoSort([])).toEqual({ waves: [], blocked: [], cyclic: [] });
  });

  it("places dependency-free nodes in one wave, sorted", () => {
    const { waves } = layeredTopoSort([node("2"), node("1")]);
    expect(waves).toEqual([["1", "2"]]);
  });

  it("layers a chain into successive waves", () => {
    const { waves } = layeredTopoSort([node("1"), node("2", ["1"]), node("3", ["2"])]);
    expect(waves).toEqual([["1"], ["2"], ["3"]]);
  });

  it("puts a node one wave past the latest of its multiple deps", () => {
    const { waves } = layeredTopoSort([node("1"), node("2", ["1"]), node("3", ["1", "2"])]);
    expect(waves).toEqual([["1"], ["2"], ["3"]]);
  });

  it("collapses a diamond into three waves", () => {
    const nodes = [node("1"), node("2", ["1"]), node("3", ["1"]), node("4", ["2", "3"])];
    expect(layeredTopoSort(nodes).waves).toEqual([["1"], ["2", "3"], ["4"]]);
  });

  it("honours a done frontier — a node whose deps are all done is wave 1", () => {
    const { waves } = layeredTopoSort([node("2", ["1"]), node("3", ["2"])], { done: ["1"] });
    expect(waves).toEqual([["2"], ["3"]]);
  });

  describe("composite refs", () => {
    it("keeps the same number in two repos distinct across a cross-repo edge", () => {
      const nodes = [node("WXYC/lml#924"), node("WXYC/bs#924", ["WXYC/lml#924"])];
      expect(layeredTopoSort(nodes).waves).toEqual([["WXYC/lml#924"], ["WXYC/bs#924"]]);
    });

    it("orders within a wave by repo then number", () => {
      const nodes = [node("WXYC/lml#5"), node("WXYC/bs#9"), node("WXYC/bs#10")];
      // "WXYC/bs" < "WXYC/lml"; within bs, 9 before 10 (numeric, not lexical).
      expect(layeredTopoSort(nodes).waves).toEqual([["WXYC/bs#9", "WXYC/bs#10", "WXYC/lml#5"]]);
    });

    it("accepts a custom order comparator", () => {
      const nodes = [node("1"), node("2"), node("3")];
      const order = (a: string, b: string) => Number(b) - Number(a); // descending
      expect(layeredTopoSort(nodes, { order }).waves).toEqual([["3", "2", "1"]]);
    });
  });

  describe("cycles", () => {
    it("reports a direct cycle as cyclic, with no waves", () => {
      const { waves, cyclic } = layeredTopoSort([node("1", ["2"]), node("2", ["1"])]);
      expect(waves).toEqual([]);
      expect(cyclic).toEqual(["1", "2"]);
    });

    it("reports a self-dependency as cyclic", () => {
      expect(layeredTopoSort([node("1", ["1"])]).cyclic).toEqual(["1"]);
    });

    it("ships the acyclic prefix and reports only the cyclic tail", () => {
      const nodes = [node("1"), node("2", ["1", "3"]), node("3", ["2"])];
      const { waves, cyclic } = layeredTopoSort(nodes);
      expect(waves).toEqual([["1"]]);
      expect(cyclic).toEqual(["2", "3"]);
    });
  });

  describe("external blockers", () => {
    it("drops a node blocked by an out-of-scope dep and marks it external", () => {
      const { waves, blocked } = layeredTopoSort([node("1", ["99"])]);
      expect(waves).toEqual([]);
      expect(blocked).toEqual([{ ref: "1", missing: ["99"], reason: "external" }]);
    });

    it("still ships the nodes that do not depend on the external blocker", () => {
      const nodes = [node("1"), node("2", ["99"])];
      const { waves, blocked } = layeredTopoSort(nodes);
      expect(waves).toEqual([["1"]]);
      expect(blocked).toEqual([{ ref: "2", missing: ["99"], reason: "external" }]);
    });

    it("marks a node blocked behind a dropped in-scope node as unreachable", () => {
      // 3 depends on 2, and 2 is externally blocked → 3 is transitively unreachable.
      const nodes = [node("2", ["99"]), node("3", ["2"])];
      const { waves, blocked } = layeredTopoSort(nodes);
      expect(waves).toEqual([]);
      const byRef = new Map(blocked.map((b) => [b.ref, b]));
      expect(byRef.get("2")!.reason).toBe("external");
      expect(byRef.get("3")!.reason).toBe("unreachable");
    });

    it("treats a done dep as satisfied, not external", () => {
      const { waves, blocked } = layeredTopoSort([node("1", ["99"])], { done: ["99"] });
      expect(waves).toEqual([["1"]]);
      expect(blocked).toEqual([]);
    });

    it("separates an external blocker from an unrelated cycle in one graph", () => {
      // Exercises the removed-external / genuine-stall interaction: after #1 is
      // dropped as external, the #2<->#3 cycle must still surface as `cyclic`,
      // not be swept up with the external blocker.
      const { waves, blocked, cyclic } = layeredTopoSort([
        node("1", ["99"]),
        node("2", ["3"]),
        node("3", ["2"]),
      ]);
      expect(waves).toEqual([]);
      expect(blocked).toEqual([{ ref: "1", missing: ["99"], reason: "external" }]);
      expect(cyclic).toEqual(["2", "3"]);
    });
  });
});
