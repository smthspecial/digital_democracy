import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EMITTER } from "../common/audit-emitter.js";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { installTestAuth, testBearer } from "../test-support/auth.js";
import { IdentityModule } from "./identity.module.js";
import { AuthProvisioner } from "./auth-provisioner.js";
import { testVerifierHeaders } from "../test-support/identity-verifier.js";

process.env.IDENTITY_HASH_SECRET ??= "test-secret";

const urls = testDatabaseUrls();

// Postgres-backed HTTP pass: a single PrismaService override points every
// module's Prisma calls at the same test database, so this exercises the
// real controller -> service -> Postgres/RLS stack end to end instead of
// swapping in an in-memory repository.
describe.skipIf(!urls)("IdentityController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.IDENTITY_VERIFIER_SHARED_SECRET = "test-verifier-secret";
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AUDIT_EMITTER)
      .useValue({ emit: async () => undefined })
      .overrideProvider(AuthProvisioner)
      .useValue({ provision: async () => ({ enrollment_grant: "test-enrollment-grant", expires_in: 300 }) })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    installTestAuth(app);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma?.onModuleDestroy();
  });

  function verify(citizenId: string, body: Record<string, string>) {
    const path = `/identity/citizens/${citizenId}/verifications`;
    return request(app.getHttpServer()).post(path).set(testVerifierHeaders(path, body)).send(body);
  }

  it("POST /identity/citizens registers a pending citizen (DP-001)", async () => {
    const res = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "alice", legalIdentifier: "national-id-123" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.legalIdentityHash).toBeDefined();
  });

  it("POST /identity/citizens rejects an invalid body (EC-10, FR-001)", async () => {
    const res = await request(app.getHttpServer()).post("/identity/citizens").send({ publicHandle: "a" });
    expect(res.status).toBe(400);
  });

  it("POST /identity/citizens rejects a missing legalIdentifier (EC-10, FR-001)", async () => {
    const res = await request(app.getHttpServer()).post("/identity/citizens").send({ publicHandle: "valid-handle" });
    expect(res.status).toBe(400);
  });

  it("full DP-001 -> DP-002 flow activates the citizen and read-own succeeds", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "bob", legalIdentifier: "id-flow-1" });
    const citizenId = registerRes.body.id;

    const verifyRes = await verify(citizenId, { method: "national_id", evidenceRef: "ref-1", outcome: "verified" });

    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.citizen.status).toBe("active");

    const readRes = await request(app.getHttpServer())
      .get(`/identity/citizens/${citizenId}`)
      .set("authorization", testBearer(citizenId));
    expect(readRes.status).toBe(200);
    expect(readRes.body.status).toBe("active");
  });

  it("GET /identity/citizens/:id without the bearer token is 401", async () => {
    const res = await request(app.getHttpServer()).get(`/identity/citizens/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("GET /identity/citizens/:id for someone else's identity is 403 (AUTH-010 own scope)", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "carol", legalIdentifier: "id-flow-2" });

    const res = await request(app.getHttpServer())
      .get(`/identity/citizens/${registerRes.body.id}`)
      .set("authorization", testBearer(randomUUID()));
    expect(res.status).toBe(403);
  });

  it("GET /identity/citizens/:id/status (BUG-002) returns only {status}, no bearer token required", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "erin", legalIdentifier: "id-flow-status-1" });
    const citizenId = registerRes.body.id;

    // No bearer token: this is the exact shape auth-service's
    // httpIdentityChecker calls with -- a service-to-service caller with no
    // requester identity of its own (BUG-002's fix). GET :id (getById)
    // requires the header and would 401 here.
    const res = await request(app.getHttpServer()).get(`/identity/citizens/${citizenId}/status`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "pending" });
    // government-identifiers-never-public: strictly less than getById.
    expect(res.body.publicHandle).toBeUndefined();
    expect(res.body.legalIdentityHash).toBeUndefined();
  });

  it("GET /identity/citizens/:id/status reflects activation", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "frank", legalIdentifier: "id-flow-status-2" });
    const citizenId = registerRes.body.id;
    await verify(citizenId, { method: "national_id", evidenceRef: "ref-1", outcome: "verified" });

    const res = await request(app.getHttpServer()).get(`/identity/citizens/${citizenId}/status`);
    expect(res.body).toEqual({ status: "active" });
  });

  it("GET /identity/citizens/:id/status for an unknown citizen is 404", async () => {
    const res = await request(app.getHttpServer()).get(`/identity/citizens/${randomUUID()}/status`);
    expect(res.status).toBe(404);
  });

  it("POST /identity/citizens rejects a duplicate legalIdentifier (HP-5, FR-001)", async () => {
    await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "ivan", legalIdentifier: "id-dup-1" });

    const res = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "ivan-two", legalIdentifier: "id-dup-1" });
    expect(res.status).toBe(409);
  });

  it("GET /identity/duplicates/scan flags a fuzzy publicHandle match the hash check wouldn't catch (HP-6, FR-001/DP-024/DP-056)", async () => {
    const oneRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "Jane Doe", legalIdentifier: "id-fuzzy-1" });
    const twoRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "jane doe", legalIdentifier: "id-fuzzy-2" });

    const res = await request(app.getHttpServer()).get("/identity/duplicates/scan");
    expect(res.status).toBe(200);
    const ids = [oneRes.body.id, twoRes.body.id].sort();
    expect(res.body).toContainEqual(
      expect.objectContaining({ citizenIdA: expect.any(String), citizenIdB: expect.any(String) }),
    );
    const pair = res.body.find(
      (s: { citizenIdA: string; citizenIdB: string }) => [s.citizenIdA, s.citizenIdB].sort().join(",") === ids.join(","),
    );
    expect(pair).toBeDefined();
  });

  it("POST /identity/verifications for a non-pending citizen is 422", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "dave", legalIdentifier: "id-flow-3" });
    const citizenId = registerRes.body.id;
    await verify(citizenId, { method: "national_id", evidenceRef: "ref-1", outcome: "verified" });

    const res = await verify(citizenId, { method: "national_id", evidenceRef: "ref-2", outcome: "verified" });
    expect(res.status).toBe(422);
  });

  it("POST /identity/verifications rejects an outcome outside verified/rejected (EC-11, FR-001)", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "grace", legalIdentifier: "id-flow-ec11-outcome" });
    const citizenId = registerRes.body.id;

    const res = await verify(citizenId, { method: "national_id", evidenceRef: "ref-1", outcome: "maybe" });
    expect(res.status).toBe(400);
  });

  it("POST /identity/verifications rejects a method outside the three known types (EC-11, FR-001)", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "heidi", legalIdentifier: "id-flow-ec11-method" });
    const citizenId = registerRes.body.id;

    const res = await verify(citizenId, { method: "drivers_license", evidenceRef: "ref-1", outcome: "verified" });
    expect(res.status).toBe(400);
  });
});
