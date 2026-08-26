import type { AuditEmitter, ProtocolChangeExecutor, ProtocolGateChecker } from "../collaborators.js";
import { conflict, forbidden } from "../errors.js";
import type { Store } from "../store.js";
import { getActionStatus } from "./approvals.js";

export interface ExecuteActionInput {
  delayElapsed: boolean;
  publiclyVisible: boolean;
}

export interface ExecuteActionResult {
  actionRef: string;
  executed: true;
  executedAt: Date;
  alreadyExecuted: boolean;
}

export function executeAction(
  store: Store,
  protocolGateChecker: ProtocolGateChecker,
  protocolChangeExecutor: ProtocolChangeExecutor,
  auditEmitter: AuditEmitter,
  actionRef: string,
  input: ExecuteActionInput,
  now: Date = new Date(),
): ExecuteActionResult {
  const existing = store.getExecution(actionRef);
  if (existing) {
    return { actionRef, executed: true, executedAt: existing.executedAt, alreadyExecuted: true };
  }

  const status = getActionStatus(store, actionRef);
  if (!status.fullyApproved) {
    throw conflict("action does not have all three required approval types");
  }
  if (!input.delayElapsed) {
    throw conflict("delay period has not elapsed");
  }
  if (!input.publiclyVisible) {
    throw conflict("change was not publicly visible during the delay window");
  }
  if (!protocolGateChecker.isConfirmed(actionRef)) {
    throw forbidden("protocol change gate has not confirmed this action");
  }

  protocolChangeExecutor.execute(actionRef);
  store.setExecution({
    actionRef,
    executedAt: now,
    delayElapsed: input.delayElapsed,
    publiclyVisible: input.publiclyVisible,
  });
  auditEmitter.emit("protocol_change.executed", { actionRef });

  return { actionRef, executed: true, executedAt: now, alreadyExecuted: false };
}
