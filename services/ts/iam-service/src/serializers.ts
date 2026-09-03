import type { AccessPolicy, PolicyAttachment, PolicyEndorsement } from "./domain/types.js";
import type { EvaluateAccessResult } from "./services/evaluate.js";

export function serializePolicy(policy: AccessPolicy) {
  return {
    id: policy.id,
    name: policy.name,
    effect: policy.effect,
    actions: policy.actions,
    resources: policy.resources,
    conditions: policy.conditions,
    description: policy.description,
    status: policy.status,
    proposed_by: policy.proposedBy,
    proposer_role_type: policy.proposerRoleType,
    created_at: policy.createdAt.toISOString(),
  };
}

export function serializeAttachment(attachment: PolicyAttachment) {
  return {
    id: attachment.id,
    policy_id: attachment.policyId,
    principal_ref: attachment.principalRef,
    status: attachment.status,
    proposed_by: attachment.proposedBy,
    proposer_role_type: attachment.proposerRoleType,
    created_at: attachment.createdAt.toISOString(),
  };
}

export function serializeEndorsement(endorsement: PolicyEndorsement) {
  return {
    id: endorsement.id,
    target_type: endorsement.targetType,
    target_id: endorsement.targetId,
    endorser_citizen_id: endorsement.endorserCitizenId,
    decision: endorsement.decision,
    created_at: endorsement.createdAt.toISOString(),
  };
}

export function serializeEvaluateResult(result: EvaluateAccessResult) {
  return {
    effect: result.effect,
    matched_policy_id: result.matchedPolicyId,
  };
}
