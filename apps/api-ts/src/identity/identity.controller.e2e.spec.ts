import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EMITTER } from "../common/audit-emitter.js";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { IdentityModule } from "./identity.module.js";

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
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [IdentityModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AUDIT_EMITTER)
      .useValue({ emit: async () => undefined })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new DomainErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma?.onModuleDestroy();
  });

  it("POST /identity/citizens registers a pending citizen (DP-001)", async () => {
    const res = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "alice", legalIdentifier: "national-id-123" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.legalIdentityHash).toBeDefined();
  });

  it("POST /identity/citizens rejects an invalid body", async () => {
    const res = await request(app.getHttpServer()).post("/identity/citizens").send({ publicHandle: "a" });
    expect(res.status).toBe(400);
  });

  it("full DP-001 -> DP-002 flow activates the citizen and read-own succeeds", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "bob", legalIdentifier: "id-flow-1" });
    const citizenId = registerRes.body.id;

    const verifyRes = await request(app.getHttpServer())
      .post("/identity/verifications")
      .set("x-citizen-id", citizenId)
      .send({ method: "national_id", evidenceRef: "ref-1", outcome: "verified" });

    expect(verifyRes.status).toBe(201);
    expect(verifyRes.body.citizen.status).toBe("active");

    const readRes = await request(app.getHttpServer())
      .get(`/identity/citizens/${citizenId}`)
      .set("x-citizen-id", citizenId);
    expect(readRes.status).toBe(200);
    expect(readRes.body.status).toBe("active");
  });

  it("GET /identity/citizens/:id without the citizen header is 401", async () => {
    const res = await request(app.getHttpServer()).get(`/identity/citizens/${randomUUID()}`);
    expect(res.status).toBe(401);
  });

  it("GET /identity/citizens/:id for someone else's identity is 403 (AUTH-010 own scope)", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "carol", legalIdentifier: "id-flow-2" });

    const res = await request(app.getHttpServer())
      .get(`/identity/citizens/${registerRes.body.id}`)
      .set("x-citizen-id", randomUUID());
    expect(res.status).toBe(403);
  });

  it("POST /identity/verifications for a non-pending citizen is 422", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "dave", legalIdentifier: "id-flow-3" });
    const citizenId = registerRes.body.id;
    await request(app.getHttpServer())
      .post("/identity/verifications")
      .set("x-citizen-id", citizenId)
      .send({ method: "national_id", evidenceRef: "ref-1", outcome: "verified" });

    const res = await request(app.getHttpServer())
      .post("/identity/verifications")
      .set("x-citizen-id", citizenId)
      .send({ method: "national_id", evidenceRef: "ref-2", outcome: "verified" });
    expect(res.status).toBe(422);
  });
});
