import { describe, expect, it } from "vitest";
import { runSynthesis } from "./synthesis.js";
import type { ArgumentInput, PreferenceInput } from "../domain/types.js";

describe("runSynthesis: shared_objectives", () => {
  it("groups preferences with identical normalized text and reports the count", () => {
    const preferences: PreferenceInput[] = [
      { description: "  More   public  transit  " },
      { description: "more public transit" },
      { description: "MORE PUBLIC TRANSIT" },
    ];
    const result = runSynthesis("prop-1", [], preferences);
    expect(result.shared_objectives).toEqual([{ description: "more public transit", count: 3 }]);
  });

  it("ignores preferences that appear only once", () => {
    const preferences: PreferenceInput[] = [
      { description: "lower taxes" },
      { description: "more parks" },
    ];
    const result = runSynthesis("prop-1", [], preferences);
    expect(result.shared_objectives).toEqual([]);
  });
});

describe("runSynthesis: conflicts", () => {
  it("reports a conflict for opposing-stance arguments sharing enough terms", () => {
    const args: ArgumentInput[] = [
      { content: "The new bridge funding will reduce traffic delay for commuters", stance: "agreement" },
      { content: "The bridge funding is wasteful and will not reduce traffic delay", stance: "disagreement" },
    ];
    const result = runSynthesis("prop-1", args, []);
    expect(result.conflicts).toHaveLength(1);
    const [conflict] = result.conflicts;
    expect(conflict?.argument_id_a).toBe(result.arguments[0]?.id);
    expect(conflict?.argument_id_b).toBe(result.arguments[1]?.id);
    expect(conflict?.overlapping_terms).toEqual(
      expect.arrayContaining(["bridge", "funding", "traffic", "delay", "reduce"]),
    );
  });

  it("reports zero conflicts for opposing-stance arguments sharing no terms", () => {
    const args: ArgumentInput[] = [
      { content: "Streetlights improve pedestrian safety at night", stance: "agreement" },
      { content: "This budget item ignores rural farmers entirely", stance: "disagreement" },
    ];
    const result = runSynthesis("prop-1", args, []);
    expect(result.conflicts).toEqual([]);
  });

  it("does not compare two arguments with the same stance", () => {
    const args: ArgumentInput[] = [
      { content: "The bridge funding will reduce traffic delay", stance: "agreement" },
      { content: "The bridge funding will reduce traffic delay too", stance: "agreement" },
    ];
    const result = runSynthesis("prop-1", args, []);
    expect(result.conflicts).toEqual([]);
  });
});

describe("runSynthesis: alternative_framings", () => {
  it("produces one framing per distinct stance present", () => {
    const args: ArgumentInput[] = [
      { content: "The bridge funding will reduce traffic delay", stance: "agreement" },
      { content: "The bridge funding is wasteful and will not reduce delay", stance: "disagreement" },
    ];
    const result = runSynthesis("prop-1", args, []);
    const stances = result.alternative_framings.map((f) => f.stance).sort();
    expect(stances).toEqual(["agreement", "disagreement"]);
    for (const framing of result.alternative_framings) {
      expect(framing.framing.length).toBeGreaterThan(0);
    }
  });

  it("produces no framings when there are no arguments", () => {
    const result = runSynthesis("prop-1", [], []);
    expect(result.alternative_framings).toEqual([]);
  });
});

describe("runSynthesis: tradeoffs", () => {
  it("reports fixed-keyword frequency across the argument set", () => {
    const args: ArgumentInput[] = [
      { content: "The cost is high but the benefit outweighs the risk", stance: "agreement" },
      { content: "Cost overruns and delay make this too risky, ignore the benefit", stance: "disagreement" },
    ];
    const result = runSynthesis("prop-1", args, []);
    const byKeyword = Object.fromEntries(result.tradeoffs.map((t) => [t.keyword, t.frequency]));
    expect(byKeyword["cost"]).toBe(2);
    expect(byKeyword["benefit"]).toBe(2);
    expect(byKeyword["delay"]).toBe(1);
    expect(byKeyword["safety"]).toBeUndefined();
    expect(byKeyword["funding"]).toBeUndefined();
  });

  it("reports no tradeoffs when no keywords appear", () => {
    const args: ArgumentInput[] = [{ content: "Streetlights improve pedestrian visibility", stance: "agreement" }];
    const result = runSynthesis("prop-1", args, []);
    expect(result.tradeoffs).toEqual([]);
  });
});

describe("runSynthesis: arguments", () => {
  it("assigns a unique id to every argument", () => {
    const args: ArgumentInput[] = [
      { content: "First argument", stance: "agreement" },
      { content: "Second argument", stance: "disagreement" },
    ];
    const result = runSynthesis("prop-1", args, []);
    expect(result.arguments).toHaveLength(2);
    expect(result.arguments[0]?.id).not.toBe(result.arguments[1]?.id);
  });
});
