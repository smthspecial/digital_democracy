import { Injectable, Logger } from "@nestjs/common";

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

  async revokeAll(citizenId: string): Promise<void> {
    if (!this.authServiceUrl) {
      return;
    }
    try {
      const response = await fetch(`${this.authServiceUrl}/auth/revoke-all`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizen_id: citizenId }),
      });
      if (!response.ok) {
        this.logger.error(`session revoke-all failed: HTTP ${response.status} for citizen ${citizenId}`);
      }
    } catch (err) {
      this.logger.error(`session revoke-all failed: ${(err as Error).message} for citizen ${citizenId}`);
    }
  }
}
