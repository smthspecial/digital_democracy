import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";

export interface SynthesisAuditEvent {
  type: "ai_synthesis.executed";
  proposalId: string;
  outputId: string;
  occurredAt: Date;
}

// This seam lets a real emitter be wired in via buildServer() without
// touching call sites.
export interface AuditEmitter {
  emit(event: SynthesisAuditEvent): void;
}

export const noopAuditEmitter: AuditEmitter = {
  emit: () => {},
};

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). ai_synthesis.executed has no dedicated TBL-034 bucket, so it
// maps to the generic system_update bucket, with the original local event
// type folded into the payload. Fire-and-forget per the AuditEmitter
// contract: a downed NATS/audit-service must never block the synthesis run
// that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    emit(event) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: "system_update",
        actor_ref: "ai-synthesis-service",
        payload: {
          event_type: event.type,
          proposalId: event.proposalId,
          outputId: event.outputId,
          occurredAt: event.occurredAt.toISOString(),
        },
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}
