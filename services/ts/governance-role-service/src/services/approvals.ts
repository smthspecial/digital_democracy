import type { AuditEmitter, COIChecker } from "../collaborators.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { APPROVAL_TYPES } from "../domain/types.js";
import type { Approval, ApprovalType, GovernanceRole } from "../domain/types.js";
import type { CreateApprovalInput, Store } from "../store.js";

export interface ActionStatus {
  actionRef: string;
  satisfiedTypes: ApprovalType[];
  requiredTypes: ApprovalType[];
  fullyApproved: boolean;
}

function isRoleActive(role: GovernanceRole, now: Date): boolean {
  return role.termStart.getTime() <= now.getTime() && now.getTime() <= role.termEnd.getTime();
}

export function submitApproval(
  store: Store,
  coiChecker: COIChecker,
  auditEmitter: AuditEmitter,
  input: CreateApprovalInput,
  now: Date = new Date(),
): Approval {
  const role = store.getRole(input.approverRoleId);
  if (!role) {
    throw notFound("approver_role_id does not reference an existing governance role");
  }
  if (!isRoleActive(role, now)) {
    throw forbidden("approver role is not active for the current term");
  }
  if (coiChecker.hasConflict(role.citizenId, input.actionRef)) {
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

  const approval = store.createApproval(input);
  auditEmitter.emit("approval.recorded", {
    actionRef: approval.actionRef,
    approverRoleId: approval.approverRoleId,
    approvalType: approval.approvalType,
    decision: approval.decision,
  });
  return approval;
}

export function getActionStatus(store: Store, actionRef: string): ActionStatus {
  const approvals = store.listApprovalsForAction(actionRef);
  const satisfiedTypes = APPROVAL_TYPES.filter((type) =>
    approvals.some((approval) => approval.approvalType === type && approval.decision === "approved"),
  );

  return {
    actionRef,
    satisfiedTypes,
    requiredTypes: [...APPROVAL_TYPES],
    fullyApproved: satisfiedTypes.length === APPROVAL_TYPES.length,
  };
}
