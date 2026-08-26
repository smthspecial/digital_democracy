import type {
  BudgetCategory,
  BudgetAllocationVote,
  LedgerEntry,
} from "./domain/types.js";

export interface Store {
  categories: Map<string, BudgetCategory>;
  allocationVotes: Map<string, BudgetAllocationVote>;
  ledgerEntries: LedgerEntry[];
}

export function createStore(): Store {
  return {
    categories: new Map(),
    allocationVotes: new Map(),
    ledgerEntries: [],
  };
}
