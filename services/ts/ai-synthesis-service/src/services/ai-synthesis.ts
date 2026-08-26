import { randomUUID } from "node:crypto";
import type { ArgumentInput, PreferenceInput, SynthesisOutput } from "../domain/types.js";
import { serializeSynthesisOutput } from "../domain/serialize.js";
import type { SynthesisStore } from "../store.js";
import type { AuditEmitter } from "../integrations/audit-emitter.js";
import { notFound } from "../errors.js";
import { runSynthesis } from "./synthesis.js";

export interface SynthesizeInput {
  proposal_id: string;
  arguments: ArgumentInput[];
  preferences: PreferenceInput[];
}

export type SynthesizeResult = SynthesisOutput | { disabled: true };

export function synthesize(
  store: SynthesisStore,
  auditEmitter: AuditEmitter,
  input: SynthesizeInput,
): SynthesizeResult {
  if (!store.isEnabled()) {
    return { disabled: true };
  }

  const analysis = runSynthesis(input.proposal_id, input.arguments, input.preferences);
  const output = serializeSynthesisOutput({
    id: randomUUID(),
    proposal_id: input.proposal_id,
    created_at: new Date(),
    flagged: false,
    flag_reasons: [],
    ...analysis,
  });
  store.create(output);
  auditEmitter.emit({
    type: "ai_synthesis.executed",
    proposalId: output.proposal_id,
    outputId: output.id,
    occurredAt: output.created_at,
  });
  return output;
}

export function toggle(store: SynthesisStore, enabled: boolean): { enabled: boolean } {
  store.setEnabled(enabled);
  return { enabled };
}

export function flagOutput(
  store: SynthesisStore,
  id: string,
  citizenId: string,
  reason: string,
): SynthesisOutput {
  const existing = store.getById(id);
  if (!existing) {
    throw notFound(`Synthesis output ${id} not found`);
  }
  const updated = serializeSynthesisOutput({
    ...existing,
    flagged: true,
    flag_reasons: [...existing.flag_reasons, { citizen_id: citizenId, reason, flagged_at: new Date() }],
  });
  store.update(updated);
  return updated;
}

export function getOutput(store: SynthesisStore, id: string): SynthesisOutput {
  const existing = store.getById(id);
  if (!existing) {
    throw notFound(`Synthesis output ${id} not found`);
  }
  return serializeSynthesisOutput(existing);
}

export function listOutputsForProposal(store: SynthesisStore, proposalId: string): SynthesisOutput[] {
  return store.listByProposal(proposalId).map((output) => serializeSynthesisOutput(output));
}
