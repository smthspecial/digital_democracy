export type ProposalStatus =
  | "draft"
  | "gathering_support"
  | "development"
  | "voting"
  | "approved"
  | "rejected"
  | "archived";

export const TERMINAL_STATUSES: readonly ProposalStatus[] = [
  "approved",
  "rejected",
  "archived",
];

// Default population-to-support-threshold ratio (FR-017); support_threshold
// = ceil(population * SUPPORT_THRESHOLD_RATIO), set at scope-assignment time.
export const SUPPORT_THRESHOLD_RATIO = 0.05;

export interface ProposalBudget {
  cost: number | null;
  fundingSource: string | null;
  maintenanceCost: number | null;
  expectedBenefits: string | null;
}

export interface ProposalConstraint {
  id: string;
  proposalId: string;
  authorId: string;
  text: string;
  // No endpoint marks a constraint agreed yet (no DP number covers it), so
  // this always stays false in this phase.
  agreed: boolean;
  createdAt: Date;
}

export interface ScopeChallenge {
  id: string;
  proposalId: string;
  citizenId: string;
  reason: string;
  resolved: boolean;
  createdAt: Date;
  resolvedAt: Date | null;
}

// FR-034: the eight-stage deadlock resolution framework (US-025, EPIC-005),
// in fixed order. A blocked proposal (development or voting) enters this
// track and progresses strictly through these stages; landing on
// final_decision with an outcome always concludes the case, so no process
// can remain permanently blocked.
export type DeadlockStage =
  | "constraint_analysis"
  | "alternative_generation"
  | "resource_partitioning"
  | "compensation_assessment"
  | "citizen_assembly_review"
  | "escalation_review"
  | "constitutional_review"
  | "final_decision";

export const DEADLOCK_STAGES: readonly DeadlockStage[] = [
  "constraint_analysis",
  "alternative_generation",
  "resource_partitioning",
  "compensation_assessment",
  "citizen_assembly_review",
  "escalation_review",
  "constitutional_review",
  "final_decision",
];

export interface DeadlockHistoryEntry {
  stage: DeadlockStage;
  reviewerId: string;
  notes: string;
  at: Date;
}

export interface DeadlockState {
  active: boolean;
  stage: DeadlockStage | null;
  enteredAt: Date | null;
  resolvedAt: Date | null;
  history: DeadlockHistoryEntry[];
}

export interface ProposalRecord {
  id: string;
  problemId: string;
  authorId: string;
  title: string;
  description: string;
  status: ProposalStatus;
  scopeJurisdictionId: string | null;
  supportCount: number;
  supportThreshold: number | null;
  // scopeChallengePending is a single flag over all challenges (DP-020) --
  // proposal-service doesn't own a scope_challenge table, so a resolved
  // challenge clears progression for the proposal as a whole rather than
  // tracking per-challenge blocking state.
  scopeChallengePending: boolean;
  createdAt: Date;
  budget: ProposalBudget;
  constraints: ProposalConstraint[];
  scopeChallenges: ScopeChallenge[];
  supporterIds: Set<string>;
  // deadlock models the FR-034 staged deadlock resolution framework as
  // embedded state, the same pattern as scopeChallengePending above --
  // proposal-service doesn't own a dedicated deadlock table either.
  deadlock: DeadlockState;
}
