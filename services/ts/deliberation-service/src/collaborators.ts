import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";

export interface AuditEmitter {
  emit(eventType: string, payload: Record<string, unknown>): void;
}

// DP-036's audit-service (SRV-012) isn't reachable from this codebase yet;
// model the hash-chained append as an injectable emitter with a no-op default.
export const noopAuditEmitter: AuditEmitter = {
  emit: () => {},
};

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). deliberation.argument.posted has no dedicated TBL-034 bucket,
// so it maps to the generic system_update bucket, with the original local
// event name folded into the payload. Fire-and-forget per the
// AuditEmitter contract: a downed NATS/audit-service must never block the
// argument post that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    emit(eventType, payload) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: "system_update",
        actor_ref: "deliberation-service",
        payload: { event_type: eventType, ...payload },
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}

export interface SynthesisTrigger {
  trigger(subjectId: string): void;
}

// DP-037's AI synthesis worker (SRV-016) isn't reachable from this codebase
// yet; model the "argument/preference volume crossed threshold" signal as an
// injectable trigger, no-op by default. Called with proposal_id for
// arguments and problem_id for preferences, since preference rows are tied
// to a problem rather than a proposal (see TBL-018).
export const noopSynthesisTrigger: SynthesisTrigger = {
  trigger: () => {},
};

export const DEFAULT_SYNTHESIS_THRESHOLD = 5;

// No ReputationEmitter seam is modeled here, unlike AuditEmitter and
// SynthesisTrigger above: SRV-014 lists deliberation-service among
// reputation-service's event sources for the "constructive" positive
// factor, but nothing in this service's feature set scores an argument's
// constructiveness -- posting one (DeliberationArgument) carries no
// quality signal at all, only stance and evidence_ref. Wiring a seam here
// would mean inventing a scoring heuristic with no specification behind
// it, so this stays an acknowledged gap rather than a fabricated trigger
// until a real "constructive" signal (e.g. a moderation or endorsement
// feature) exists to drive it.
