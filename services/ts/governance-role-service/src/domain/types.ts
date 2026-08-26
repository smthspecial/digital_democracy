export type RoleType =
  | "auditor"
  | "reviewer"
  | "oversight"
  | "operator"
  | "platform_operator"
  | "review_body";

export const ROLE_TYPES: readonly RoleType[] = [
  "auditor",
  "reviewer",
  "oversight",
  "operator",
  "platform_operator",
  "review_body",
];

export type Layer = "protocol" | "implementation" | "audit" | "citizen";

export const LAYERS: readonly Layer[] = ["protocol", "implementation", "audit", "citizen"];

export type ApprovalType = "citizen_supermajority" | "audit_confirmation" | "body_endorsement";

export const APPROVAL_TYPES: readonly ApprovalType[] = [
  "citizen_supermajority",
  "audit_confirmation",
  "body_endorsement",
];

export type ApprovalDecision = "approved" | "rejected";

export interface GovernanceRole {
  id: string;
  citizenId: string;
  roleType: RoleType;
  layer: Layer;
  termStart: Date;
  termEnd: Date;
  randomized: boolean;
  offboardingNotified: boolean;
}

export interface Approval {
  id: string;
  actionRef: string;
  approverRoleId: string;
  approvalType: ApprovalType;
  decision: ApprovalDecision;
  createdAt: Date;
}

export interface ActionExecution {
  actionRef: string;
  executedAt: Date;
  delayElapsed: boolean;
  publiclyVisible: boolean;
}
