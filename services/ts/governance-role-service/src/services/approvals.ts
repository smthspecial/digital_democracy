import type { AuditEmitter, COIChecker } from "../collaborators.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { APPROVAL_TYPES } from "../domain/types.js";
import type { Approval, ApprovalType, GovernanceRole, Layer } from "../domain/types.js";
import type { CreateApprovalInput, Store } from "../store.js";

// ADR-001's four independent accountability layers back each of the three
// required approval types one-to-one: a citizen_supermajority speaks for
// the citizen layer, an audit_confirmation for the audit layer, and a
// body_endorsement for the protocol layer (a review body / protocol
// council seat). Without this mapping, any role holder could supply any
// approval type, collapsing the layers into one and defeating ADR-001's
// "no single layer can modify, execute, and validate" guarantee -- see
// ARCH-021 EC-26.
const REQUIRED_LAYER_BY_APPROVAL_TYPE: Record<ApprovalType, Layer> = {
  citizen_supermajority: "citizen",
  audit_confirmation: "audit",
  body_endorsement: "protocol",
};

export interface ActionStatus {
  actionRef: string;
  satisfiedTypes: ApprovalType[];
  requiredTypes: ApprovalType[];
  fullyApproved: boolean;
}

function isRoleActive(role: GovernanceRole, now: Date): boolean {
  return role.termStart.getTime() <= now.getTime() && now.getTime() <= role.termEnd.getTime();
}

export async function submitApproval(
  store: Store,
  coiChecker: COIChecker,
  auditEmitter: AuditEmitter,
  input: CreateApprovalInput,
  now: Date = new Date(),
): Promise<Approval> {
  const role = store.getRole(input.approverRoleId);
  if (!role) {
    throw notFound("approver_role_id does not reference an existing governance role");
  }
  if (!isRoleActive(role, now)) {
    throw forbidden("approver role is not active for the current term");
  }
  if (await coiChecker.hasConflict(role.citizenId, input.actionRef)) {
    throw forbidden("citizen has a conflict of interest for this action");
  }

  const existing = store.listApprovalsForAction(input.actionRef);
  const alreadySubmitted = existing.some((approval) => {
    const approverRole = store.getRole(approval.approverRoleId);
    return approverRole?.citizenId === role.citizenId;
  });
  if (alreadySubmitted) {
    throw conflict("citizen has already submitted an approval for this action_ref");
  }

  const requiredLayer = REQUIRED_LAYER_BY_APPROVAL_TYPE[input.approvalType];
  if (role.layer !== requiredLayer) {
    throw forbidden(
      `approval_type ${input.approvalType} requires a role in the ${requiredLayer} layer, but approver_role_id is in the ${role.layer} layer`,
    );
  }

  const approval = store.createApproval(input);
  auditEmitter.emit("approval.recorded", {
    actionRef: approval.actionRef,
    approverRoleId: approval.approverRoleId,
    approvalType: approval.approvalType,
    decision: approval.decision,
  });
  return approval;
}

// ARCH-010 EC-9: submitApproval only validates isRoleActive at write time; a
// role whose term_end has since passed must not go on counting toward
// fully_approved forever just because its approval was accepted while the
// term was still current -- re-validate role activity here, at read time,
// against `now` for every approval before counting it as satisfying its
// type.
export function getActionStatus(store: Store, actionRef: string, now: Date = new Date()): ActionStatus {
  const approvals = store.listApprovalsForAction(actionRef);
  const satisfiedTypes = APPROVAL_TYPES.filter((type) =>
    approvals.some((approval) => {
      if (approval.approvalType !== type || approval.decision !== "approved") return false;
      const role = store.getRole(approval.approverRoleId);
      return role !== undefined && isRoleActive(role, now);
    }),
  );

  return {
    actionRef,
    satisfiedTypes,
    requiredTypes: [...APPROVAL_TYPES],
    fullyApproved: satisfiedTypes.length === APPROVAL_TYPES.length,
  };
}
