export type Channel = "email" | "push" | "in_app";

export const CHANNELS: readonly Channel[] = ["email", "push", "in_app"];

export type NotificationStatus = "delivered" | "skipped" | "retrying" | "failed";

export interface NotificationRecord {
  id: string;
  citizenId: string;
  eventType: string;
  channel: Channel;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export type PreferenceMap = Record<Channel, boolean>;
