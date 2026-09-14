export type AccessPolicyEffect = "allow" | "deny";
export type AccessPolicyStatus = "pending_approval" | "active" | "rejected" | "revoked";
export type PolicyAttachmentStatus = "pending_approval" | "active" | "revoked";
export type PolicyEndorsementTargetType = "policy" | "attachment";
export type PolicyEndorsementDecision = "approved" | "rejected";

export interface AccessPolicy {
  id: string;
  name: string;
  effect: AccessPolicyEffect;
  actions: string[];
  resources: string[];
  conditions: Record<string, unknown> | null;
  description: string;
  status: AccessPolicyStatus;
  proposedBy: string;
  createdAt: Date;
}

export interface PolicyAttachment {
  id: string;
  policyId: string;
  principalRef: string;
  status: PolicyAttachmentStatus;
  proposedBy: string;
  createdAt: Date;
}

export interface PolicyEndorsement {
  id: string;
  targetType: PolicyEndorsementTargetType;
  targetId: string;
  endorserCitizenId: string;
  decision: PolicyEndorsementDecision;
  createdAt: Date;
}

export interface ProposePolicyInput {
  name: string;
  effect: AccessPolicyEffect;
  actions: string[];
  resources: string[];
  conditions?: Record<string, unknown> | null;
  description: string;
}

export interface ProposeAttachmentInput {
  policyId: string;
  principalRef: string;
}

export interface InsertEndorsementInput {
  targetType: PolicyEndorsementTargetType;
  targetId: string;
  decision: PolicyEndorsementDecision;
}

export interface AccessPolicyListFilter {
  status?: AccessPolicyStatus;
}

export interface PolicyAttachmentListFilter {
  policyId?: string;
  principalRef?: string;
  status?: PolicyAttachmentStatus;
}

export interface PolicyEndorsementListFilter {
  targetType?: PolicyEndorsementTargetType;
  targetId?: string;
}

export interface EvaluateAccessInput {
  principalRef: string;
  action: string;
  resource: string;
  context?: Record<string, unknown>;
}

export interface EvaluateAccessResult {
  effect: "allow" | "deny";
  matchedPolicyId: string | null;
}
