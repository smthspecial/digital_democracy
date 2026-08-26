export type CivicAssignmentType =
  | "proposal_review"
  | "audit_review"
  | "expertise_verification"
  | "budget_oversight";

export type CivicAssignmentStatus =
  | "assigned"
  | "completed"
  | "abandoned"
  | "exempted";

export interface CivicAssignment {
  id: string;
  citizenId: string;
  type: CivicAssignmentType;
  targetRef: string;
  assignedAt: Date;
  dueAt: Date | null;
  status: CivicAssignmentStatus;
}

export type ExemptionStatus =
  | "none"
  | "illness"
  | "disability"
  | "military"
  | "caregiving"
  | "other";

export type InactivityStage = 0 | 1 | 2 | 3;

export interface ParticipationRecord {
  id: string;
  citizenId: string;
  period: string;
  score: number;
  quotaTarget: number;
  exemptionStatus: ExemptionStatus;
  inactivityStage: InactivityStage;
}
