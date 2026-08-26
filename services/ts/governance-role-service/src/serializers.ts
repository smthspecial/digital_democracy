import type { ActionStatus } from "./services/approvals.js";
import type { ExecuteActionResult } from "./services/execution.js";
import type { Approval, GovernanceRole } from "./domain/types.js";

export function serializeRole(role: GovernanceRole) {
  return {
    id: role.id,
    citizen_id: role.citizenId,
    role_type: role.roleType,
    layer: role.layer,
    term_start: role.termStart.toISOString(),
    term_end: role.termEnd.toISOString(),
    randomized: role.randomized,
    offboarding_notified: role.offboardingNotified,
  };
}

export function serializeApproval(approval: Approval) {
  return {
    id: approval.id,
    action_ref: approval.actionRef,
    approver_role_id: approval.approverRoleId,
    approval_type: approval.approvalType,
    decision: approval.decision,
    created_at: approval.createdAt.toISOString(),
  };
}

export function serializeActionStatus(status: ActionStatus) {
  return {
    action_ref: status.actionRef,
    required_approval_types: status.requiredTypes,
    satisfied_approval_types: status.satisfiedTypes,
    fully_approved: status.fullyApproved,
  };
}

export function serializeExecutionResult(result: ExecuteActionResult) {
  return {
    action_ref: result.actionRef,
    executed: result.executed,
    executed_at: result.executedAt.toISOString(),
    already_executed: result.alreadyExecuted,
  };
}
