import type { SynthesisOutput } from "./domain/types.js";

export interface SynthesisStore {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  create(output: SynthesisOutput): void;
  update(output: SynthesisOutput): void;
  getById(id: string): SynthesisOutput | undefined;
  listByProposal(proposalId: string): SynthesisOutput[];
}

export function createSynthesisStore(): SynthesisStore {
  const outputs = new Map<string, SynthesisOutput>();
  let enabled = true;

  return {
    isEnabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = value;
    },
    create(output) {
      outputs.set(output.id, output);
    },
    update(output) {
      outputs.set(output.id, output);
    },
    getById(id) {
      return outputs.get(id);
    },
    listByProposal(proposalId) {
      return [...outputs.values()].filter((output) => output.proposal_id === proposalId);
    },
  };
}
