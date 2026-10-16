import { InternalServiceGuard, SignedRequestVerifier } from "../common/internal-service.guard.js";
import { ForbiddenException, INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthProvisioner } from "./auth-provisioner.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";
import { DuplicateDetectionService } from "./duplicate-detection.service.js";
import { IdentityVerifierGuard } from "./identity-verifier.guard.js";
import { testVerifierHeaders } from "../test-support/identity-verifier.js";

describe("identity verification and auth provisioning boundary", () => {
  let app: INestApplication;
  const citizenId = "00000000-0000-4000-8000-000000000001";
  const path = `/identity/citizens/${citizenId}/verifications`;
  const input = { method: "national_id", evidenceRef: "private-evidence-ref", outcome: "verified" };
  const identity = { submitVerification: vi.fn(), assertVerifiedIdentity: vi.fn() };
  const provision = vi.fn();
  beforeAll(async () => {
    vi.stubEnv("IDENTITY_VERIFIER_SHARED_SECRET", "test-verifier-secret");
    const module = await Test.createTestingModule({
      controllers: [IdentityController],
      providers: [InternalServiceGuard, SignedRequestVerifier, IdentityVerifierGuard, { provide: IdentityService, useValue: identity },
        { provide: DuplicateDetectionService, useValue: {} }, { provide: AuthProvisioner, useValue: { provision } }],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); vi.unstubAllEnvs(); });

  it("rejects public, tampered, and expired callbacks before activation", async () => {
    expect((await request(app.getHttpServer()).post(path).send(input)).status).toBe(401);
    expect((await request(app.getHttpServer()).post(path).set(testVerifierHeaders(path, input)).send({ ...input, outcome: "rejected" })).status).toBe(401);
    const expired = Math.floor(Date.now() / 1000 - 301).toString();
    expect((await request(app.getHttpServer()).post(path).set(testVerifierHeaders(path, input, expired)).send(input)).status).toBe(401);
    expect(identity.submitVerification).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("provisions only after the trusted callback activates the identity", async () => {
    identity.submitVerification.mockResolvedValue({ citizen: { id: citizenId, status: "active" }, verification: { status: "verified" } });
    provision.mockResolvedValue({ enrollment_grant: "opaque-grant", expires_in: 300 });
    const result = await request(app.getHttpServer()).post(path).set(testVerifierHeaders(path, input)).send(input);
    expect(result.status).toBe(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.enrollment).toEqual({ enrollment_grant: "opaque-grant", expires_in: 300 });
    expect(provision).toHaveBeenCalledWith(citizenId);
    expect(identity.submitVerification).toHaveBeenCalledWith(citizenId, input);
  });

  it("a rejection does not issue enrollment credentials", async () => {
    provision.mockClear();
    identity.submitVerification.mockResolvedValue({ citizen: { status: "pending" }, verification: { status: "rejected" } });
    const body = { ...input, outcome: "rejected" };
    const result = await request(app.getHttpServer()).post(path).set(testVerifierHeaders(path, body)).send(body);
    expect(result.status).toBe(201);
    expect(provision).not.toHaveBeenCalled();
  });

  it("requires trusted verification again before retrying grant delivery", async () => {
    const retryPath = `/identity/citizens/${citizenId}/enrollment-grant`;
    provision.mockClear();
    expect((await request(app.getHttpServer()).post(retryPath).send({})).status).toBe(401);
    identity.assertVerifiedIdentity.mockRejectedValueOnce(new ForbiddenException());
    expect((await request(app.getHttpServer()).post(retryPath).set(testVerifierHeaders(retryPath, {})).send({})).status).toBe(403);
    expect(provision).not.toHaveBeenCalled();
    identity.assertVerifiedIdentity.mockResolvedValueOnce(undefined);
    const result = await request(app.getHttpServer()).post(retryPath).set(testVerifierHeaders(retryPath, {})).send({});
    expect(result.status).toBe(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(identity.assertVerifiedIdentity).toHaveBeenCalledWith(citizenId);
    expect(provision).toHaveBeenCalledWith(citizenId);
  });
});
