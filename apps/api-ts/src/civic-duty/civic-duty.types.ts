export type CivicAssignmentType = "proposal_review" | "audit_review" | "expertise_verification" | "budget_oversight";
export type CivicAssignmentStatus = "assigned" | "completed" | "abandoned" | "exempted";
export type ExemptionStatus = "none" | "illness" | "disability" | "military" | "caregiving" | "other";

export interface CivicAssignment {
  id: string;
  citizenId: string;
  type: CivicAssignmentType;
  targetRef: string;
  assignedAt: Date;
  dueAt: Date;
  status: CivicAssignmentStatus;
}

export interface ParticipationRecord {
  id: string;
  citizenId: string;
  period: string;
  score: number;
  quotaTarget: number | null;
  exemptionStatus: ExemptionStatus;
  inactivityStage: number;
}

export interface CivicAssignmentListFilter {
  status?: CivicAssignmentStatus;
}

export interface ParticipationRecordListFilter {
  period?: string;
}
