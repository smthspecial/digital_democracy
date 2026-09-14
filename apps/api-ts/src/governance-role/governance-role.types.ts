export type GovernanceRoleType =
  | "auditor"
  | "reviewer"
  | "oversight"
  | "operator"
  | "platform_operator"
  | "review_body";

// ADR-001's four independent accountability layers (Protocol/Implementation/
// Audit/Citizen).
export type GovernanceLayer = "protocol" | "implementation" | "audit" | "citizen";

export type ApprovalType = "citizen_supermajority" | "audit_confirmation" | "body_endorsement";

export type ApprovalDecision = "approved" | "rejected";

// TBL-032 has NO status column -- "active" is purely a function of today
// falling within [termStart, termEnd] (see
// GovernanceRoleService.findActiveRoleForCitizen's term-window query).
export interface GovernanceRole {
  id: string;
  citizenId: string;
  roleType: GovernanceRoleType;
  layer: GovernanceLayer;
  termStart: Date;
  termEnd: Date;
  randomized: boolean;
}

export interface Approval {
  id: string;
  actionRef: string;
  approverRoleId: string;
  approvalType: ApprovalType;
  decision: ApprovalDecision;
  createdAt: Date;
}

export interface GovernanceRoleListFilter {
  citizenId?: string;
  roleType?: GovernanceRoleType;
}

export interface InsertApprovalInput {
  actionRef: string;
  approverRoleId: string;
  approvalType: ApprovalType;
  decision: ApprovalDecision;
}
