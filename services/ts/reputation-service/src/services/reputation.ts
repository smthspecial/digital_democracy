import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";
import {
  FACTOR_POLARITY,
  SIGNIFICANT_DELTA_THRESHOLD,
  type FactorType,
  type ReputationRecord,
} from "../domain/types.js";
import { validationError } from "../errors.js";
import type { ReputationStore } from "../store.js";

// audit-service and notification-service aren't implemented yet, so these
// model the DP-036/DP-039 emissions as no-op-by-default injectable seams.
export interface NotificationEmitter {
  notifySignificantDelta(record: ReputationRecord): void;
}

export interface AuditEmitter {
  emit(eventType: string, record: ReputationRecord): void;
}

export const noopNotificationEmitter: NotificationEmitter = {
  notifySignificantDelta() {
    // no-op default
  },
};

export const noopAuditEmitter: AuditEmitter = {
  emit() {
    // no-op default
  },
};

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). reputation.record_created has no dedicated TBL-034 bucket, so
// it maps to the generic system_update bucket, with the original local
// event type folded into the payload. Fire-and-forget per the AuditEmitter
// contract: a downed NATS/audit-service must never block the reputation
// record that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    emit(eventType, record) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: "system_update",
        actor_ref: "reputation-service",
        payload: {
          event_type: eventType,
          id: record.id,
          citizenId: record.citizenId,
          factorType: record.factorType,
          delta: record.delta,
          sourceRef: record.sourceRef,
          createdAt: record.createdAt.toISOString(),
        },
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}

export interface ReputationDeps {
  store: ReputationStore;
  notifications: NotificationEmitter;
  audit: AuditEmitter;
}

export interface RecordEventInput {
  citizenId: string;
  factorType: FactorType;
  delta: number;
  sourceRef: string | null;
}

export interface CitizenReputation {
  citizenId: string;
  total: number;
  records: ReputationRecord[];
}

export function recordEvent(deps: ReputationDeps, input: RecordEventInput): ReputationRecord {
  const polarity = FACTOR_POLARITY[input.factorType];

  if (polarity === "positive" && !(input.delta > 0)) {
    throw validationError(`factor_type '${input.factorType}' is positive-polarity and requires delta > 0`);
  }
  if (polarity === "negative" && !(input.delta < 0)) {
    throw validationError(`factor_type '${input.factorType}' is negative-polarity and requires delta < 0`);
  }

  const sourceRef = input.sourceRef && input.sourceRef.trim() !== "" ? input.sourceRef : null;
  if (polarity === "negative" && sourceRef === null) {
    throw validationError("source_ref is required for a negative-polarity reputation record");
  }

  const record: ReputationRecord = {
    id: randomUUID(),
    citizenId: input.citizenId,
    factorType: input.factorType,
    delta: input.delta,
    sourceRef,
    createdAt: new Date(),
  };

  deps.store.addRecord(record);
  deps.audit.emit("reputation.record_created", record);
  if (Math.abs(record.delta) >= SIGNIFICANT_DELTA_THRESHOLD) {
    deps.notifications.notifySignificantDelta(record);
  }

  return record;
}

export function getCitizenReputation(store: ReputationStore, citizenId: string): CitizenReputation {
  const records = store.listByCitizen(citizenId);
  const total = records.reduce((sum, record) => sum + record.delta, 0);
  return { citizenId, total, records };
}

export function getCitizenRecords(store: ReputationStore, citizenId: string): ReputationRecord[] {
  return store.listByCitizen(citizenId);
}
