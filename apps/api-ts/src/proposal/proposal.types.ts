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
  scopeRationale: string | null;
  scopeEscalationReason: string | null;
  objectives: string | null;
  measurableOutcomes: string | null;
  implementationTimeline: string | null;
  deadlockActive: boolean;
  deadlockStage: DeadlockStage | null;
}

export interface ProposalConstraint {
  id: string;
  proposalId: string;
  text: string;
  agreed: boolean;
}

export type DeadlockStage =
  | "constraint_analysis"
  | "alternative_generation"
  | "resource_partitioning"
  | "compensation_assessment"
  | "citizen_assembly_review"
  | "escalation_review"
  | "constitutional_review"
  | "final_decision";

export interface DeadlockHistoryEntry {
  id: string;
  proposalId: string;
  stage: DeadlockStage;
  reviewerId: string;
  notes: string;
  at: Date;
}

export type ScopeChallengeStatus = "open" | "upheld" | "dismissed";

export interface ScopeChallenge {
  id: string;
  proposalId: string;
  challengerId: string;
  reason: string;
  status: ScopeChallengeStatus;
  resolution: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
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
