export interface BudgetCategory {
  id: string;
  jurisdictionId: string;
  parentId: string | null;
  name: string;
  allocatedAmount: number;
  createdAt: Date;
}

export interface CategoryTreeNode extends BudgetCategory {
  children: CategoryTreeNode[];
}

export interface BudgetAllocationVote {
  id: string;
  citizenId: string;
  categoryId: string;
  percentage: number;
  period: string;
  createdAt: Date;
}

export type LedgerEntryType = "inflow" | "outflow";

export interface LedgerEntry {
  id: string;
  categoryId: string | null;
  // TBL-028's project_id: links an outflow to the project-service project
  // it funded, so a project's real spend is traceable in the public
  // ledger, not just tracked separately by project-service's own record.
  projectId: string | null;
  type: LedgerEntryType;
  amount: number;
  description: string;
  recordedBy: string;
  createdAt: Date;
}

export interface AllocationAggregateResult {
  categoryId: string;
  averagePercentage: number;
  voteCount: number;
  allocatedAmount: number;
}

export interface ReconciliationResult {
  categoryId: string;
  allocated: number;
  spent: number;
  discrepancy: number;
}
