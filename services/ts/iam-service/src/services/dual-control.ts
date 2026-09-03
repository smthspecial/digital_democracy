// Shared dual-control state-machine logic (ADR-025, ARCH-024 §2/§5) used by
// both policies.ts and attachments.ts -- access_policy and policy_attachment
// go through the *identical* propose/endorse/revoke rules (DP-069/070/072),
// just against two different tables, so the eligibility checks live here
// once rather than being reimplemented (and potentially drifting) twice.
import type { GovernanceRoleChecker } from "../collaborators.js";
import { conflict, forbidden } from "../errors.js";
import type { EndorsementTargetType, RoleType } from "../domain/types.js";
import type { Store } from "../store.js";

// AUTH-006 (operator) / AUTH-011 (platform-operator) -- the only role types
// that may propose a grant (DP-069). Checked in this order: a citizen who
// holds both is pinned to whichever is found first, purely to make the
// pinned proposerRoleType deterministic -- both are equally eligible to
// propose, so the order carries no other significance.
const GRANTOR_ROLE_TYPES: readonly RoleType[] = ["operator", "platform_operator"];

// AUTH-006 / AUTH-011 / AUTH-003 (auditor) -- who may revoke unilaterally,
// no dual control (DP-072, DP-068's grant/revoke asymmetry).
const REVOKER_ROLE_TYPES: readonly RoleType[] = ["operator", "platform_operator", "auditor"];

// DP-069: resolves and returns whichever of GRANTOR_ROLE_TYPES the proposer
// actively, currently holds (live check, never trusted from the request
// body) -- this becomes the row's pinned proposerRoleType. Throws 403 if
// neither.
export async function resolveProposerRoleType(
  governanceRoleChecker: GovernanceRoleChecker,
  proposedBy: string,
): Promise<RoleType> {
  for (const roleType of GRANTOR_ROLE_TYPES) {
    if (await governanceRoleChecker.hasActiveRole(proposedBy, roleType)) {
      return roleType;
    }
  }
  throw forbidden("proposer must hold an active operator or platform_operator governance role");
}

// DP-070: the three endorsement eligibility rules, in order --
// 1. endorser must be a different citizen than the proposer (no self-endorsement).
// 2. endorser must actively hold a governance role of the SAME role_type the
//    proposer was verified against at propose time (ARCH-024 §2) -- live check.
// 3. one endorsement per citizen per target (TBL-042's own UNIQUE constraint,
//    enforced here since the in-memory store doesn't enforce it itself).
export async function assertCanEndorse(
  store: Store,
  governanceRoleChecker: GovernanceRoleChecker,
  targetType: EndorsementTargetType,
  targetId: string,
  proposedBy: string,
  proposerRoleType: RoleType,
  endorserCitizenId: string,
): Promise<void> {
  if (endorserCitizenId === proposedBy) {
    throw forbidden("endorser must be a different citizen than the proposer");
  }
  if (!(await governanceRoleChecker.hasActiveRole(endorserCitizenId, proposerRoleType))) {
    throw forbidden(
      `endorser must hold an active ${proposerRoleType} governance role, matching the proposer's role_type`,
    );
  }
  const existing = store.listEndorsementsForTarget(targetType, targetId);
  if (existing.some((endorsement) => endorsement.endorserCitizenId === endorserCitizenId)) {
    throw conflict("citizen has already submitted an endorsement for this target");
  }
}

// DP-072: no dual control -- any one of REVOKER_ROLE_TYPES, held live and
// active, is sufficient. Throws 403 if none match.
export async function assertCanRevoke(
  governanceRoleChecker: GovernanceRoleChecker,
  revokerCitizenId: string,
): Promise<void> {
  for (const roleType of REVOKER_ROLE_TYPES) {
    if (await governanceRoleChecker.hasActiveRole(revokerCitizenId, roleType)) {
      return;
    }
  }
  throw forbidden(
    "revoker must hold an active operator, platform_operator, or auditor governance role",
  );
}
