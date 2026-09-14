export type LedgerDirection = "inflow" | "outflow";

export interface BudgetCategory {
  id: string;
  jurisdictionId: string;
  parentId: string | null;
  name: string;
  // Non-null only after DP-051's aggregation cron runs (out of scope,
  // ADR-030) -- null until then.
  allocatedAmount: number | null;
}

export interface BudgetAllocationVote {
  id: string;
  citizenId: string;
  categoryId: string;
  percentage: number;
  period: string;
}

export interface LedgerEntry {
  id: string;
  jurisdictionId: string;
  categoryId: string | null;
  // Cross-service reference to project-service's `project` (TBL-029, not
  // built in this app) -- no FK, mirrors ProposalBudget.fundingCategoryId's
  // precedent (proposal.types.ts).
  projectId: string | null;
  direction: LedgerDirection;
  amount: number;
  source: string;
  occurredAt: Date;
}

export interface AllocationEntryInput {
  categoryId: string;
  percentage: number;
}

export interface ReplaceAllocationForPeriodInput {
  citizenId: string;
  period: string;
  allocations: AllocationEntryInput[];
}

// Shared verbatim between BudgetService.recordLedgerEntry and
// BudgetRepository.recordLedgerEntry -- there is no citizen actor to strip
// off between layers here (unlike, say, ProposalService.addBudget's
// AddBudgetInput vs proposal.types.ts's UpsertBudgetInput), so one shape
// serves both.
export interface RecordLedgerEntryInput {
  jurisdictionId: string;
  categoryId?: string | null;
  projectId?: string | null;
  direction: LedgerDirection;
  amount: number;
  source: string;
  occurredAt: Date;
}

export interface BudgetCategoryListFilter {
  jurisdictionId?: string;
}

export interface LedgerEntryListFilter {
  jurisdictionId?: string;
  categoryId?: string;
  projectId?: string;
}
