export type CompetencyStatus = "applied" | "active" | "rejected" | "expired" | "revoked";
export type CompetencyChallengeReason = "credentials" | "conflict" | "false_claim" | "misconduct";
export type CompetencyChallengeStatus = "open" | "reviewing" | "upheld" | "dismissed";
export type ConflictOfInterestType = "employer" | "ownership" | "consulting" | "financial";

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
  grantedAt: Date | null;
  expiresAt: Date | null;
}

export interface CompetencyChallenge {
  id: string;
  competencyId: string;
  challengerId: string;
  evidenceRef: string;
  reason: CompetencyChallengeReason;
  status: CompetencyChallengeStatus;
  decision: string | null;
}

export interface ConflictOfInterest {
  id: string;
  citizenId: string;
  domainId: string;
  type: ConflictOfInterestType;
  description: string;
  disclosedAt: Date;
}

export interface ExpertAssessment {
  id: string;
  proposalId: string;
  expertId: string;
  domainId: string;
  technicalScore: number;
  economicScore: number;
  socialScore: number;
  sustainabilityScore: number;
  body: string;
  createdAt: Date;
}

export interface ApplyForCompetencyInput {
  citizenId: string;
  domainId: string;
  level: number;
}

export interface DeclareConflictOfInterestInput {
  citizenId: string;
  domainId: string;
  type: ConflictOfInterestType;
  description: string;
}

export interface SubmitCompetencyChallengeInput {
  competencyId: string;
  challengerId: string;
  evidenceRef: string;
  reason: CompetencyChallengeReason;
}

export interface PublishAssessmentInput {
  proposalId: string;
  expertId: string;
  domainId: string;
  technicalScore: number;
  economicScore: number;
  socialScore: number;
  sustainabilityScore: number;
  body: string;
}

export interface CompetencyListFilter {
  citizenId?: string;
  domainId?: string;
}

export interface AssessmentListFilter {
  proposalId?: string;
}
