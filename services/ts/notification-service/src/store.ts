import { randomUUID } from "node:crypto";
import type { Channel, NotificationRecord, NotificationStatus, PreferenceMap } from "./domain/types.js";

export interface NewNotification {
  citizenId: string;
  eventType: string;
  channel: Channel;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  attempts: number;
}

export interface NotificationPatch {
  status?: NotificationStatus;
  attempts?: number;
}

export interface Store {
  createNotification(input: NewNotification): NotificationRecord;
  getNotification(id: string): NotificationRecord | undefined;
  updateNotification(id: string, patch: NotificationPatch): NotificationRecord;
  listByCitizen(citizenId: string): NotificationRecord[];
  getPreference(citizenId: string, channel: Channel): boolean;
  setPreference(citizenId: string, channel: Channel, enabled: boolean): void;
  getPreferences(citizenId: string): PreferenceMap;
}

export function createStore(): Store {
  const notifications = new Map<string, NotificationRecord>();
  const preferences = new Map<string, Map<Channel, boolean>>();

  return {
    createNotification(input) {
      const now = new Date();
      const record: NotificationRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...input,
      };
      notifications.set(record.id, record);
      return record;
    },

    getNotification(id) {
      return notifications.get(id);
    },

    updateNotification(id, patch) {
      const existing = notifications.get(id);
      if (!existing) {
        throw new Error(`notification ${id} not found`);
      }
      const updated: NotificationRecord = { ...existing, ...patch, updatedAt: new Date() };
      notifications.set(id, updated);
      return updated;
    },

    listByCitizen(citizenId) {
      return [...notifications.values()]
        .filter((notification) => notification.citizenId === citizenId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    getPreference(citizenId, channel) {
      // No stored row means the channel defaults to enabled (SRV-015: no channel is mandatory,
      // but absence of an explicit opt-out must not silently suppress delivery).
      return preferences.get(citizenId)?.get(channel) ?? true;
    },

    setPreference(citizenId, channel, enabled) {
      const citizenPrefs = preferences.get(citizenId) ?? new Map<Channel, boolean>();
      citizenPrefs.set(channel, enabled);
      preferences.set(citizenId, citizenPrefs);
    },

    getPreferences(citizenId) {
      const citizenPrefs = preferences.get(citizenId);
      return {
        email: citizenPrefs?.get("email") ?? true,
        push: citizenPrefs?.get("push") ?? true,
        in_app: citizenPrefs?.get("in_app") ?? true,
      };
    },
  };
}
