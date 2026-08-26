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
}
