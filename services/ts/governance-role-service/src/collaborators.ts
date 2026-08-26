// Seams for integrations that have no live implementation to call in this
// phase (audit-service's DP-043 gate, competency-service's COI signal,
// the actual protocol-change apply step, and notification/civic-duty-service
// dispatch from DP-050). Each interface gets a no-op/permissive default
// wired into buildServer() and can be swapped for a real client later
// without touching callers.

export interface ProtocolGateChecker {
  isConfirmed(actionRef: string): boolean;
}

export interface COIChecker {
  hasConflict(citizenId: string, actionRef: string): boolean;
}

export interface ProtocolChangeExecutor {
  execute(actionRef: string): void;
}

export interface NotificationEmitter {
  notify(roleId: string, message: string): void;
}

export interface ReplacementRequester {
  requestReplacement(roleId: string): void;
}

export interface AuditEmitter {
  emit(event: string, payload: Record<string, unknown>): void;
}

export const defaultProtocolGateChecker: ProtocolGateChecker = {
  isConfirmed: () => true,
};

export const defaultCOIChecker: COIChecker = {
  hasConflict: () => false,
};

export const defaultProtocolChangeExecutor: ProtocolChangeExecutor = {
  execute: () => undefined,
};

export const defaultNotificationEmitter: NotificationEmitter = {
  notify: () => undefined,
};

export const defaultReplacementRequester: ReplacementRequester = {
  requestReplacement: () => undefined,
};

export const defaultAuditEmitter: AuditEmitter = {
  emit: () => undefined,
};
