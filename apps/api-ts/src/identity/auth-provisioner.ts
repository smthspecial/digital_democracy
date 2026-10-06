import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash, createHmac } from "node:crypto";

export interface EnrollmentGrant { enrollment_grant: string; expires_in: number }

@Injectable()
export class AuthProvisioner {
  async provision(citizenId: string): Promise<EnrollmentGrant> {
    const url = process.env.AUTH_SERVICE_URL;
    const secret = process.env.INTERNAL_SERVICE_SHARED_SECRET;
    if (!url || !secret) throw new ServiceUnavailableException("Auth provisioning is not configured");
    const path = "/auth/identities/provision";
    const body = JSON.stringify({ citizen_id: citizenId });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hash = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", secret).update(`POST\n${path}\n${timestamp}\n${hash}`).digest("hex");
    try {
      const response = await fetch(`${url}${path}`, {
        method: "POST", body, signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json", "x-dd-service": "api-ts", "x-dd-timestamp": timestamp, "x-dd-signature": signature },
      });
      if (!response.ok) throw new Error("Provisioning failed");
      const grant = await response.json() as EnrollmentGrant;
      if (!grant.enrollment_grant || typeof grant.expires_in !== "number") throw new Error("Invalid grant response");
      return grant;
    } catch {
      throw new ServiceUnavailableException("Auth provisioning is unavailable; retry the enrollment-grant endpoint");
    }
  }
}
