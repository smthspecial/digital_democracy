import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";

// ThresholdChecker models DP-028's async check against proposal-service --
// whether any proposal linked to this problem has crossed its support
// threshold. proposal-service isn't implemented here, so the default is a
// no-op; a real integration would enqueue/call out instead.
export interface ThresholdChecker {
  checkThreshold(problemId: string, supportCount: number): void;
}

export const noopThresholdChecker: ThresholdChecker = {
  checkThreshold() {
    /* no linked proposal-service to notify yet */
  },
};

// AuditEmitter models the DP-036 audit-service emission on problem creation
// and status changes; audit-service isn't implemented here, so this is a
// no-op by default.
export interface AuditEmitter {
  emit(eventType: string, payload: Record<string, unknown>): void;
}

export const noopAuditEmitter: AuditEmitter = {
  emit() {
    /* no audit-service to notify yet */
  },
};

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). problem.created/problem.status_changed have no dedicated
// TBL-034 bucket of their own (unlike proposal-service's events, which get
// proposal_created/proposal_status_changed), so both fall under the
// generic system_update bucket, with the original local event name folded
// into the payload's event_type field. Fire-and-forget per the
// AuditEmitter contract: a downed NATS/audit-service must never block the
// problem submission or status change that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    emit(eventType, payload) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: "system_update",
        actor_ref: "problem-service",
        payload: { event_type: eventType, ...payload },
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}
