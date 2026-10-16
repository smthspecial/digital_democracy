import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { serviceHeaders } from "../common/internal-service.guard.js";

export interface EnrollmentGrant { enrollment_grant: string; expires_in: number }

@Injectable()
export class AuthProvisioner {
  async provision(citizenId: string): Promise<EnrollmentGrant> {
    const url = process.env.AUTH_SERVICE_URL;
    const secret = process.env.INTERNAL_SERVICE_SHARED_SECRET;
    if (!url || !secret) throw new ServiceUnavailableException("Auth provisioning is not configured");
    const path = "/auth/identities/provision";
    const body = JSON.stringify({ citizen_id: citizenId });
    try {
      const response = await fetch(`${url}${path}`, {
        method: "POST", body, signal: AbortSignal.timeout(3000),
        headers: { "content-type": "application/json", ...serviceHeaders("POST", path, body) },
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
