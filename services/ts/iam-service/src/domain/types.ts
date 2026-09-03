// RoleType mirrors governance-role-service's own domain/types.ts exactly
// (SRV-011) -- iam-service verifies proposer/endorser/revoker eligibility
// against that same set of role types, live over HTTP (ARCH-024 §2), so it
// must recognize every value governance-role-service can return, not just
// the three this service's own rules key off (operator, platform_operator,
// auditor -- AUTH-006/AUTH-011/AUTH-003).
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

export type Effect = "allow" | "deny";

export const EFFECTS: readonly Effect[] = ["allow", "deny"];

export type PolicyStatus = "pending_approval" | "active" | "rejected" | "revoked";

export const POLICY_STATUSES: readonly PolicyStatus[] = [
  "pending_approval",
  "active",
  "rejected",
  "revoked",
];

export type AttachmentStatus = "pending_approval" | "active" | "revoked";

export const ATTACHMENT_STATUSES: readonly AttachmentStatus[] = [
  "pending_approval",
  "active",
  "revoked",
];

export type EndorsementTargetType = "policy" | "attachment";

export const ENDORSEMENT_TARGET_TYPES: readonly EndorsementTargetType[] = ["policy", "attachment"];

export type EndorsementDecision = "approved" | "rejected";

export const ENDORSEMENT_DECISIONS: readonly EndorsementDecision[] = ["approved", "rejected"];

// TBL-040. Publicly readable (no hidden or exclusive grants, CON-005);
// activates only via dual-control endorsement (TBL-042, ARCH-024 §5).
//
// proposerRoleType is NOT one of TBL-040's documented columns -- it is an
// addition made by the services/ layer (policies.ts). ARCH-024 §2 requires
// an endorser to hold "the same role_type as the proposer", but a proposer
// can legitimately hold *both* operator and platform_operator at once
// (RoleType is not exclusive), so "the proposer's role_type" is ambiguous
// unless pinned down at propose time. Re-deriving it live at endorsement
// time would just move the ambiguity, not resolve it, and would cost a
// second lookup ARCH-024 §2 doesn't otherwise require. Storing the
// already-verified qualifying role_type on the row itself is the smallest
// fix. Flagged here the same way db/migrations/0001_init.up.sql flags
// TBL-041's own status-enum gap: a follow-up migration will need to add a
// matching `proposer_role_type` column before this can move off the
// in-memory store.
export interface AccessPolicy {
  id: string;
  name: string;
  effect: Effect;
  actions: string[];
  resources: string[];
  conditions: Record<string, unknown> | null;
  description: string;
  status: PolicyStatus;
  proposedBy: string;
  proposerRoleType: RoleType;
  createdAt: Date;
}

// TBL-041. principalRef is `citizen:<uuid>` or `role:operator` /
// `role:platform_operator` (ARCH-024 §1) -- resolved against
// governance-role-service's current role holders at evaluation time, not
// stored as a fixed citizen list.
//
// proposerRoleType: same addition, and same rationale, as AccessPolicy's
// field above -- attachments go through the identical dual-control
// propose/endorse flow (DP-069/070) and need the same pinned-at-propose-time
// role_type to resolve endorsement eligibility unambiguously.
export interface PolicyAttachment {
  id: string;
  policyId: string;
  principalRef: string;
  status: AttachmentStatus;
  proposedBy: string;
  proposerRoleType: RoleType;
  createdAt: Date;
}

// TBL-042. One endorsement per citizen per target
// (UNIQUE (target_type, target_id, endorser_citizen_id)) -- enforced by the
// service layer against this store, mirroring DP-068's break-glass
// co-approval, not DP-035's three-layer approval (ARCH-024 §2).
export interface PolicyEndorsement {
  id: string;
  targetType: EndorsementTargetType;
  targetId: string;
  endorserCitizenId: string;
  decision: EndorsementDecision;
  createdAt: Date;
}
