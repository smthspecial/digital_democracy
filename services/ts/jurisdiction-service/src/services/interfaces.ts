// DP-035: scope-level changes require protocol-layer approval coordinated by
// governance-role-service, which doesn't exist in this codebase yet -- fake
// defaults to always-approved so callers can inject a stricter gate in tests.
export type ApprovalGate = (jurisdictionId: string) => boolean;
export const defaultApprovalGate: ApprovalGate = () => true;

// DP-036: structural changes are appended to the hash-chained audit log
// owned by audit-service, which doesn't exist in this codebase yet -- no-op
// default; a real emitter would enqueue onto the audit.append queue.
export type AuditEmitter = (eventType: string, payload: Record<string, unknown>) => void;
export const noopAuditEmitter: AuditEmitter = () => {};
