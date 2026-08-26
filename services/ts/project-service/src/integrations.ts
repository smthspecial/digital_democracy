// audit-service (DP-036) and civic-duty-service (DP-053's assignment queue)
// are separate processes not implemented in this codebase yet. Both calls
// are modeled as injectable seams with no-op default implementations, per
// the cross-service simplification convention used across this phase.
export interface AuditEvent {
  type: string;
  projectId: string;
  at: Date;
  details?: Record<string, unknown>;
}

export interface AuditEmitter {
  emit(event: AuditEvent): void;
}

export const noopAuditEmitter: AuditEmitter = {
  emit: () => {},
};

export interface AssignmentRequester {
  request(projectId: string): void;
}

export const noopAssignmentRequester: AssignmentRequester = {
  request: () => {},
};
