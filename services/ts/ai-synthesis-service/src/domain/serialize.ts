import type { ModelProvenance, SynthesisOutput } from "./types.js";

export const MANDATORY_LABEL =
  "AI-generated analysis — advisory only, subject to human review.";

// Stands in for a real LLM call (ADR-007/FR-031 require no live model here);
// published alongside every output so provenance is always auditable.
export const MODEL_PROVENANCE: ModelProvenance = {
  model_name: "rule-based-synthesis-v1",
  version: "1.0.0",
  training_data_summary:
    "No trained model is used. Output is derived deterministically from the arguments/preferences supplied in the request.",
};

type UnlabeledSynthesisOutput = Omit<SynthesisOutput, "label" | "model_provenance"> &
  Partial<Pick<SynthesisOutput, "label" | "model_provenance">>;

/**
 * Every code path that returns a SynthesisOutput MUST route it through this
 * function. It unconditionally sets (overwrites) the mandatory label and
 * model provenance, so neither can ever be dropped or forged upstream.
 */
export function serializeSynthesisOutput(output: UnlabeledSynthesisOutput): SynthesisOutput {
  return {
    ...output,
    label: MANDATORY_LABEL,
    model_provenance: MODEL_PROVENANCE,
  };
}
