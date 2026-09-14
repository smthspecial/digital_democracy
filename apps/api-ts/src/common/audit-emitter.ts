import { Injectable, Logger } from "@nestjs/common";

export const AUDIT_EMITTER = Symbol("AUDIT_EMITTER");

// DP-036 ("Audit log append") is owned by audit-service (SRV-012, apps/api-go)
// -- this app has no audit_log table. Fires only where a DP doc in this pass
// explicitly says "Emits DP-036" (DP-002 on activation, DP-003, DP-005;
// ADR-030) via HTTP when AUDIT_SERVICE_URL is set, else a no-op -- the same
// seam shape as api-go's AuditEmitter (apps/api-go/internal/delegation/service.go).
export interface AuditEvent {
  actionType: string;
  actorRef: string;
  payload: Record<string, unknown>;
}

export interface AuditEmitter {
  emit(event: AuditEvent): Promise<void>;
}

@Injectable()
export class HttpAuditEmitter implements AuditEmitter {
  private readonly logger = new Logger(HttpAuditEmitter.name);
  private readonly auditServiceUrl = process.env.AUDIT_SERVICE_URL;

  async emit(event: AuditEvent): Promise<void> {
    if (!this.auditServiceUrl) {
      return;
    }
    try {
      const response = await fetch(`${this.auditServiceUrl}/audit/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        this.logger.warn(`audit emit failed: HTTP ${response.status}`);
      }
    } catch (err) {
      // Best-effort: an audit delivery failure must never block the
      // governance process that triggered it (mirrors notification-service's
      // key rule, SRV-015).
      this.logger.warn(`audit emit failed: ${(err as Error).message}`);
    }
  }
}
