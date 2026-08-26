import type { ProposalRecord } from "./domain/types.js";

export function createStore() {
  const proposals = new Map<string, ProposalRecord>();

  return {
    save(record: ProposalRecord): void {
      proposals.set(record.id, record);
    },
    get(id: string): ProposalRecord | undefined {
      return proposals.get(id);
    },
    list(): ProposalRecord[] {
      return Array.from(proposals.values());
    },
  };
}

export type ProposalStore = ReturnType<typeof createStore>;
