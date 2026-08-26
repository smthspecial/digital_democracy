import { describe, expect, it } from "vitest";
import { MANDATORY_LABEL, MODEL_PROVENANCE, serializeSynthesisOutput } from "./serialize.js";
import type { SynthesisOutput } from "./types.js";

function buildBareOutput() {
  return {
    id: "out-1",
    proposal_id: "prop-1",
    created_at: new Date("2026-01-01T00:00:00Z"),
    arguments: [],
    shared_objectives: [],
    conflicts: [],
    alternative_framings: [],
    tradeoffs: [],
    flagged: false,
    flag_reasons: [],
  };
}

describe("serializeSynthesisOutput", () => {
  it("attaches the mandatory label to an output constructed without one", () => {
    const result = serializeSynthesisOutput(buildBareOutput());
    expect(result.label).toBe(MANDATORY_LABEL);
  });

  it("overwrites a forged label rather than trusting the caller", () => {
    const tampered = {
      ...buildBareOutput(),
      label: "totally official, no review needed",
    } as unknown as SynthesisOutput;
    const result = serializeSynthesisOutput(tampered);
    expect(result.label).toBe(MANDATORY_LABEL);
  });

  it("attaches model provenance to every output", () => {
    const result = serializeSynthesisOutput(buildBareOutput());
    expect(result.model_provenance).toEqual(MODEL_PROVENANCE);
  });
});
