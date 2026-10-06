import type { NextFunction, Request, Response } from "express";

export interface AuthenticatedCitizen {
  citizenId: string;
  sessionId: string;
  assuranceTier: string;
}

export type AuthenticatedRequest = Request & { auth?: AuthenticatedCitizen };

type FetchLike = typeof fetch;

const BEARER_PREFIX = "Bearer ";
const AUTH_VALIDATE_TIMEOUT_MS = 3_000;

function writeAuthError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function authenticatedCitizenId(request: Request): string | undefined {
  return (request as AuthenticatedRequest).auth?.citizenId;
}

export function createAuthContextMiddleware(fetchImpl: FetchLike = fetch, authServiceUrlOverride?: string) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.header("authorization");
    if (!authorization) {
      next();
      return;
    }
    if (!authorization.startsWith(BEARER_PREFIX) || authorization.length === BEARER_PREFIX.length) {
      writeAuthError(response, 401, "unauthorized", "Invalid bearer token");
      return;
    }

    const authServiceUrl = authServiceUrlOverride ?? process.env.AUTH_SERVICE_URL;
    if (!authServiceUrl) {
      writeAuthError(response, 503, "authentication_unavailable", "Authentication service is not configured");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_VALIDATE_TIMEOUT_MS);
    try {
      const authResponse = await fetchImpl(`${authServiceUrl}/auth/validate`, {
        headers: { authorization },
        signal: controller.signal,
      });
      if (authResponse.status === 401 || authResponse.status === 403) {
        writeAuthError(response, 401, "unauthorized", "Invalid or expired bearer token");
        return;
      }
      if (!authResponse.ok) {
        writeAuthError(response, 503, "authentication_unavailable", "Authentication service is unavailable");
        return;
      }

      const body: unknown = await authResponse.json();
      if (
        !body ||
        typeof body !== "object" ||
        typeof (body as Record<string, unknown>).citizen_id !== "string" ||
        typeof (body as Record<string, unknown>).session_id !== "string" ||
        typeof (body as Record<string, unknown>).assurance_tier !== "string"
      ) {
        writeAuthError(response, 503, "authentication_unavailable", "Authentication service returned an invalid response");
        return;
      }

      (request as AuthenticatedRequest).auth = {
        citizenId: (body as Record<string, string>).citizen_id,
        sessionId: (body as Record<string, string>).session_id,
        assuranceTier: (body as Record<string, string>).assurance_tier,
      };
      next();
    } catch {
      writeAuthError(response, 503, "authentication_unavailable", "Authentication service is unavailable");
    } finally {
      clearTimeout(timeout);
    }
  };
}
