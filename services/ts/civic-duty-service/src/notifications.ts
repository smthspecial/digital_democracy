// Models the notification-service emission (DP-039: assignment/reminder/inactivity
// warnings) as an injectable seam -- notification-service isn't implemented in
// this codebase, so the default is a no-op.
export type NotificationKind = "inactivity_reminder" | "inactivity_reduced";

export interface NotificationEvent {
  citizenId: string;
  kind: NotificationKind;
  period: string;
}

export interface NotificationEmitter {
  notify(event: NotificationEvent): void;
}

export const noopNotificationEmitter: NotificationEmitter = {
  notify() {
    /* no notification-service to dispatch to yet */
  },
};
