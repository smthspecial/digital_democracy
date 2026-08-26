import type { Store } from "../store.js";
import type { Providers } from "./providers.js";
import type { Channel, NotificationRecord } from "../domain/types.js";
import { findBannedKey } from "./redaction.js";
import { validation, notFound } from "../errors.js";

// Documented retry ceiling (SRV-015: best-effort with a retry policy). One dispatch attempt plus
// up to this many total attempts before a notification is marked permanently 'failed'.
export const MAX_DELIVERY_ATTEMPTS = 3;

export interface DispatchInput {
  citizenId: string;
  eventType: string;
  channel: Channel;
  payload: Record<string, unknown>;
}

export async function dispatchNotification(
  store: Store,
  providers: Providers,
  input: DispatchInput,
): Promise<NotificationRecord> {
  const bannedKey = findBannedKey(input.payload);
  if (bannedKey !== undefined) {
    throw validation(`notification payload must not contain private field "${bannedKey}"`);
  }

  if (!store.getPreference(input.citizenId, input.channel)) {
    return store.createNotification({
      citizenId: input.citizenId,
      eventType: input.eventType,
      channel: input.channel,
      payload: input.payload,
      status: "skipped",
      attempts: 0,
    });
  }

  const record = store.createNotification({
    citizenId: input.citizenId,
    eventType: input.eventType,
    channel: input.channel,
    payload: input.payload,
    status: "retrying",
    attempts: 0,
  });

  return attemptDelivery(store, providers, record);
}

export async function retryNotification(
  store: Store,
  providers: Providers,
  id: string,
): Promise<NotificationRecord> {
  const record = store.getNotification(id);
  if (!record) {
    throw notFound(`notification ${id} not found`);
  }
  // Only a notification still mid-retry is eligible; delivered/skipped/failed are terminal.
  if (record.status !== "retrying") {
    return record;
  }
  return attemptDelivery(store, providers, record);
}

async function attemptDelivery(
  store: Store,
  providers: Providers,
  record: NotificationRecord,
): Promise<NotificationRecord> {
  const provider = providers[record.channel];
  let delivered: boolean;
  try {
    delivered = await provider.send(record.citizenId, record.eventType, record.payload);
  } catch {
    // A provider failure is best-effort and must never propagate to the dispatch caller.
    delivered = false;
  }

  if (delivered) {
    return store.updateNotification(record.id, { status: "delivered" });
  }

  const attempts = record.attempts + 1;
  const status = attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "retrying";
  return store.updateNotification(record.id, { attempts, status });
}
