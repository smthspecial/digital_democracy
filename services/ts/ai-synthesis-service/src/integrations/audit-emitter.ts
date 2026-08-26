export interface SynthesisAuditEvent {
  type: "ai_synthesis.executed";
  proposalId: string;
  outputId: string;
  occurredAt: Date;
}

// audit-service is not a live integration in this phase (SRV-016 DP-036
// dependency); this seam lets a real emitter be wired in via buildServer()
// later without touching call sites.
export interface AuditEmitter {
  emit(event: SynthesisAuditEvent): void;
}

export const noopAuditEmitter: AuditEmitter = {
  emit: () => {},
};
