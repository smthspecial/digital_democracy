import { Injectable, Logger } from "@nestjs/common";

export const NOTIFICATION_EMITTER = Symbol("NOTIFICATION_EMITTER");

// notification-service (SRV-015) owns no tables per its own srv-NNN.md and
// is explicitly out of scope for this app (ARCH-023 §1: "notification-service
// (SRV-015) and ai-synthesis-service (SRV-016) own no tables... and are out
// of scope for this pass") -- it is a pure consumer of the
// `notifications.dispatch` queue (DP-039) that every other service publishes
// to, never implemented here. This port is the same seam shape as
// AuditEmitter for audit-service: HTTP POST to NOTIFICATION_SERVICE_URL when
// set, else a no-op. Fires only where a Key Rules section in this pass's
// scope explicitly says "Emits to: notification-service" (civic-duty-service:
// new assignment/reminder/inactivity warning; project-service: milestone
// delays/completion; reputation-service: significant delta).
export interface NotificationEvent {
  eventType: string;
  citizenId: string;
  payload: Record<string, unknown>;
}

export interface NotificationEmitter {
  emit(event: NotificationEvent): Promise<void>;
}

@Injectable()
export class HttpNotificationEmitter implements NotificationEmitter {
  private readonly logger = new Logger(HttpNotificationEmitter.name);
  private readonly notificationServiceUrl = process.env.NOTIFICATION_SERVICE_URL;

  constructor() {
    // BUG-003: nothing in either runtime serves POST /notifications/dispatch
    // yet (ADR-031 carve-out) -- a configured URL will 404 on every emit,
    // the same silent-failure shape BUG-001 was. Warn loudly at startup.
    if (this.notificationServiceUrl) {
      this.logger.warn(
        `NOTIFICATION_SERVICE_URL is set (${this.notificationServiceUrl}) but no notification-service ` +
          `implementation exists yet (ADR-031); dispatches will fail`,
      );
    }
  }

  async emit(event: NotificationEvent): Promise<void> {
    if (!this.notificationServiceUrl) {
      return;
    }
    try {
      const response = await fetch(`${this.notificationServiceUrl}/notifications/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        this.logger.warn(`notification emit failed: HTTP ${response.status}`);
      }
    } catch (err) {
      // SRV-015.md's own key rule: "A delivery failure must not block the
      // upstream governance process that triggered it" -- best-effort,
      // mirrors HttpAuditEmitter.emit.
      this.logger.warn(`notification emit failed: ${(err as Error).message}`);
    }
  }
}
