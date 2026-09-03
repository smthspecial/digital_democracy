// DP-069 (propose) / DP-070 (endorse) / DP-072 (revoke) for access_policy
// (TBL-040). Mirrors governance-role-service's services/approvals.ts +
// services/roles.ts shape: plain async functions taking (store, collaborator
// seams, input, now) and throwing DomainError subtypes on rejection -- no
// fastify/route concerns here, those belong to routes/policies.ts.
import type { AuditEmitter, GovernanceRoleChecker } from "../collaborators.js";
import { conflict, notFound } from "../errors.js";
import type {
  AccessPolicy,
  Effect,
  EndorsementDecision,
  PolicyEndorsement,
  PolicyStatus,
} from "../domain/types.js";
import type { Store } from "../store.js";
import { assertCanEndorse, assertCanRevoke, resolveProposerRoleType } from "./dual-control.js";

export interface ListPoliciesFilter {
  status?: PolicyStatus;
}

export interface ProposePolicyInput {
  name: string;
  effect: Effect;
  actions: string[];
  resources: string[];
  conditions: Record<string, unknown> | null;
  description: string;
  proposedBy: string;
}

export interface EndorsePolicyInput {
  endorserCitizenId: string;
  decision: EndorsementDecision;
}

export interface EndorsePolicyResult {
  endorsement: PolicyEndorsement;
  policy: AccessPolicy;
}

export interface RevokePolicyInput {
  revokedBy: string;
}

// DP-069: verifies input.proposedBy holds an active operator or
// platform_operator role (live, 403 if neither), creates the row
// (status: pending_approval), and emits policy.proposed either way.
export async function proposePolicy(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  auditEmitter: AuditEmitter,
  input: ProposePolicyInput,
  now: Date = new Date(),
): Promise<AccessPolicy> {
  const proposerRoleType = await resolveProposerRoleType(governanceRoleChecker, input.proposedBy);

  const policy = store.createPolicy({ ...input, proposerRoleType });
  auditEmitter.emit("policy.proposed", {
    policyId: policy.id,
    proposedBy: policy.proposedBy,
    proposerRoleType,
    occurredAt: now.toISOString(),
  });
  return policy;
}

// Plain read, no eligibility check (every policy is publicly readable,
// ADR-025/TBL-040 Notes) -- mirrors governance-role-service's
// services/roles.ts listRoles pass-through to the store's own filter.
export function listPolicies(store: Store, filter: ListPoliciesFilter = {}): AccessPolicy[] {
  const policies = store.listPolicies();
  return filter.status ? policies.filter((policy) => policy.status === filter.status) : policies;
}

// DP-070: dual-control endorsement. Rejects self-endorsement and a
// different-role-type endorser (403), and a second endorsement from the
// same citizen (409, TBL-042's own UNIQUE constraint). An approved decision
// activates the policy; a rejected decision rejects it (either is terminal
// -- TBL-040's status enum has both). Emits policy.activated /
// policy.rejected either way.
export async function endorsePolicy(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  auditEmitter: AuditEmitter,
  policyId: string,
  input: EndorsePolicyInput,
  now: Date = new Date(),
): Promise<EndorsePolicyResult> {
  const policy = store.getPolicy(policyId);
  if (!policy) {
    throw notFound(`no access_policy with id ${policyId}`);
  }
  // assertCanEndorse's duplicate-endorsement check runs before the
  // pending_approval check below on purpose: it must still catch the same
  // citizen calling twice even after their first call already decided (and
  // thus terminated) the target -- see policies.test.ts's
  // "rejects a second endorsement from the same citizen".
  await assertCanEndorse(
    store,
    governanceRoleChecker,
    "policy",
    policyId,
    policy.proposedBy,
    policy.proposerRoleType,
    input.endorserCitizenId,
  );
  if (policy.status !== "pending_approval") {
    throw conflict(`access_policy ${policyId} is not pending approval (status: ${policy.status})`);
  }

  const endorsement = store.createEndorsement({
    targetType: "policy",
    targetId: policyId,
    endorserCitizenId: input.endorserCitizenId,
    decision: input.decision,
  });

  const nextStatus = input.decision === "approved" ? "active" : "rejected";
  const updated = store.setPolicyStatus(policyId, nextStatus);
  auditEmitter.emit(input.decision === "approved" ? "policy.activated" : "policy.rejected", {
    policyId,
    endorserCitizenId: input.endorserCitizenId,
    decision: input.decision,
    occurredAt: now.toISOString(),
  });

  return { endorsement, policy: updated };
}

// DP-072: unilateral revoke -- no dual control. Any operator,
// platform_operator, or auditor may revoke a policy that is currently
// active or pending_approval (the trigger condition DP-072 itself
// documents); an already-terminal rejected/revoked policy cannot be
// revoked again.
export async function revokePolicy(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  auditEmitter: AuditEmitter,
  policyId: string,
  input: RevokePolicyInput,
  now: Date = new Date(),
): Promise<AccessPolicy> {
  const policy = store.getPolicy(policyId);
  if (!policy) {
    throw notFound(`no access_policy with id ${policyId}`);
  }
  if (policy.status !== "active" && policy.status !== "pending_approval") {
    throw conflict(`cannot revoke access_policy ${policyId} with status ${policy.status}`);
  }

  await assertCanRevoke(governanceRoleChecker, input.revokedBy);

  const revoked = store.setPolicyStatus(policyId, "revoked");
  auditEmitter.emit("policy.revoked", {
    policyId,
    revokedBy: input.revokedBy,
    occurredAt: now.toISOString(),
  });
  return revoked;
}
