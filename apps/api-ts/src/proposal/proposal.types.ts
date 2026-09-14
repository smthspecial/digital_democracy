export type ProposalStatus =
  | "draft"
  | "gathering_support"
  | "development"
  | "voting"
  | "approved"
  | "rejected"
  | "archived";

export interface Proposal {
  id: string;
  problemId: string;
  authorId: string;
  title: string;
  description: string;
  scopeJurisdictionId: string | null;
  supportCount: number;
  supportThreshold: number;
  status: ProposalStatus;
  createdAt: Date;
  // DP-020 ("File scope challenge"): non-null while a scope dispute is
  // open. tbl-008.md's column list doesn't name this even though DP-020
  // declares TBL-008 as its only table -- a spec omission, not a missing
  // column (see prisma/schema.prisma's note, ADR-030).
  scopeChallengedAt: Date | null;
}

export interface ProposalConstraint {
  id: string;
  proposalId: string;
  text: string;
  agreed: boolean;
}

export interface ProposalBudget {
  id: string;
  proposalId: string;
  cost: number | null;
  fundingSource: string | null;
  fundingCategoryId: string | null;
  maintenanceCost: number | null;
  longTermCost: number | null;
  expectedBenefits: string | null;
}

export interface CreateProposalInput {
  problemId: string;
  authorId: string;
  title: string;
  description: string;
  supportThreshold: number;
}

export interface AddConstraintInput {
  proposalId: string;
  text: string;
}

export interface UpsertBudgetInput {
  proposalId: string;
  cost?: number;
  fundingSource?: string;
  fundingCategoryId?: string;
  maintenanceCost?: number;
  longTermCost?: number;
  expectedBenefits?: string;
}

export interface ProposalListFilter {
  problemId?: string;
}
