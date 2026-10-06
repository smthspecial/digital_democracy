import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedCitizenId, AuthenticatedRequest, createAuthContextMiddleware } from "./auth-context.js";

function request(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    headers,
  } as unknown as Request;
}

function response(): { value: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { value: { status } as unknown as Response, status, json };
}

describe("auth context middleware", () => {
  const originalAuthUrl = process.env.AUTH_SERVICE_URL;
  afterEach(() => {
    process.env.AUTH_SERVICE_URL = originalAuthUrl;
  });

  it("allows an unauthenticated request through for public routes", async () => {
    const next = vi.fn();
    await createAuthContextMiddleware()(request(), response().value, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("adds citizen context only after auth-service validates the bearer token", async () => {
    process.env.AUTH_SERVICE_URL = "http://auth.example";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ citizen_id: "citizen-1", session_id: "session-1", assurance_tier: "T2" }), { status: 200 }),
    );
    const req = request({ authorization: "Bearer valid-token" });
    const next = vi.fn();

    await createAuthContextMiddleware(fetchImpl)(req, response().value, next);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://auth.example/auth/validate",
      expect.objectContaining({ headers: { authorization: "Bearer valid-token" } }),
    );
    expect((req as AuthenticatedRequest).auth).toEqual({ citizenId: "citizen-1", sessionId: "session-1", assuranceTier: "T2" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects an invalid bearer token", async () => {
    process.env.AUTH_SERVICE_URL = "http://auth.example";
    const res = response();
    await createAuthContextMiddleware(vi.fn().mockResolvedValue(new Response(null, { status: 401 })))(
      request({ authorization: "Bearer invalid-token" }),
      res.value,
      vi.fn(),
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: { code: "unauthorized", message: "Invalid or expired bearer token" } });
  });

  it("never derives identity from an arbitrary request header", () => {
    expect(authenticatedCitizenId(request({ "x-citizen-id": "forged" }))).toBeUndefined();
  });
});
