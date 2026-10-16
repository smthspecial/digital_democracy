import { Injectable, Logger } from "@nestjs/common";
import { serviceHeaders } from "../common/internal-service.guard.js";

export const SESSION_REVOKER = Symbol("SESSION_REVOKER");

export interface SessionRevoker {
  revokeAll(citizenId: string): Promise<void>;
}

// DP-042's cascade: identity-service had no seam of any kind for pushing a
// completed revocation to auth-service's session store (the audit's
// "revoked-record-remains-inspectable" finding's root cause). Same seam
// shape as HttpAuditEmitter/HttpNotificationEmitter -- best-effort, never
// blocks the revocation itself (a session-revocation delivery failure must
// not leave citizen.status un-updated), logged loudly on failure.
@Injectable()
export class HttpSessionRevoker implements SessionRevoker {
  private readonly logger = new Logger(HttpSessionRevoker.name);
  private readonly authServiceUrl = process.env.AUTH_SERVICE_URL;
  private readonly internalSharedSecret = process.env.INTERNAL_SERVICE_SHARED_SECRET;

  async revokeAll(citizenId: string): Promise<void> {
    if (!this.authServiceUrl) {
      return;
    }
    if (!this.internalSharedSecret) {
      this.logger.error("session revoke-all is disabled: INTERNAL_SERVICE_SHARED_SECRET is not configured");
      return;
    }
    const path = "/auth/revoke-all";
    const body = JSON.stringify({ citizen_id: citizenId });
    try {
      const response = await fetch(`${this.authServiceUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...serviceHeaders("POST", path, body),
        },
        body, signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        this.logger.error(`session revoke-all failed: HTTP ${response.status} for citizen ${citizenId}`);
      }
    } catch (err) {
      this.logger.error(`session revoke-all failed: ${(err as Error).message} for citizen ${citizenId}`);
    }
  }
}
