import { randomUUID } from "node:crypto";
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
