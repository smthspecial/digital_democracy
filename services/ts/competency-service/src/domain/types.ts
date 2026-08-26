export type CompetencyStage =
  | "application"
  | "automated_credential_check"
  | "public_review_period"
  | "domain_review"
  | "recorded_approval";

// FR-022 five-stage pipeline, in fixed order. Advancement always moves
// exactly one stage forward; reaching the last one completes the pipeline.
export const COMPETENCY_STAGES: readonly CompetencyStage[] = [
  "application",
  "automated_credential_check",
  "public_review_period",
  "domain_review",
  "recorded_approval",
];

export type CompetencyStatus = "applied" | "active" | "expired" | "revoked" | "rejected";

export interface ExpertDomain {
  id: string;
  name: string;
  description: string;
}

export interface Competency {
  id: string;
  citizenId: string;
  domainId: string;
  level: number;
  status: CompetencyStatus;
  stage: CompetencyStage;
  grantedAt: Date | null;
  expiresAt: Date | null;
}

export type ConflictType = "employer" | "ownership" | "consulting" | "financial";

export interface ConflictOfInterest {
  id: string;
  citizenId: string;
  domainId: string;
  description: string;
  disclosedAt: Date;
}

export type ChallengeReason = "credentials" | "conflict" | "false_claim" | "misconduct";
export type ChallengeStatus = "open" | "reviewing" | "upheld" | "dismissed";

export interface CompetencyChallenge {
  id: string;
  competencyId: string;
  challengerId: string;
  evidenceRef: string;
  reason: ChallengeReason;
  status: ChallengeStatus;
  decision: string | null;
}

export interface ExpertAssessment {
  id: string;
  proposalId: string;
  expertId: string;
  domainId: string;
  content: string;
  score: number;
  createdAt: Date;
}
