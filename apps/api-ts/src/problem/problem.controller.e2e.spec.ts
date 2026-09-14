import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EMITTER } from "../common/audit-emitter.js";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { ProblemModule } from "./problem.module.js";

process.env.IDENTITY_HASH_SECRET ??= "test-secret";

const urls = testDatabaseUrls();

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls!.admin });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function insertJurisdiction(id: string, name: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction (id, name, scope_level, boundary_ref) VALUES ($1, $2, 'municipality', $3)`, [
      id,
      name,
      `ref-${id}`,
    ]),
  );
}

async function insertMembership(citizenId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction_membership (id, citizen_id, jurisdiction_id) VALUES ($1, $2, $3)`, [
      randomUUID(),
      citizenId,
      jurisdictionId,
    ]),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, ProblemModule's own imports plus
// IdentityModule/JurisdictionModule/ProposalModule's) points every module's
// Prisma calls at the same test database, so this exercises the real
// controller -> service -> Postgres/RLS stack end to end instead of
// swapping in per-module in-memory repositories -- JurisdictionModule's
// real JurisdictionService (JURISDICTION_MEMBERSHIP_CHECKER) now resolves
// membership from real jurisdiction_membership rows rather than a fake set.
describe.skipIf(!urls)("ProblemController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [ProblemModule] })
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

  // Registers + activates a fresh citizen through the (transitively
  // imported) IdentityModule routes, exactly like proposal.controller.e2e.spec.ts's flow.
  async function activeCitizen(handle: string): Promise<string> {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: handle, legalIdentifier: `id-${handle}` });
    const citizenId = registerRes.body.id;
    await request(app.getHttpServer())
      .post("/identity/verifications")
      .set("x-citizen-id", citizenId)
      .send({ method: "national_id", evidenceRef: "ref-1", outcome: "verified" });
    return citizenId;
  }

  it("POST /problem/problems creates an open problem (DP-003)", async () => {
    const citizenId = await activeCitizen("alice");
    const jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");

    const res = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "Pothole", description: "Big pothole", affectedArea: "Main St", jurisdictionId });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.authorId).toBe(citizenId);
  });

  it("POST /problem/problems rejects an invalid body", async () => {
    const citizenId = await activeCitizen("bob");
    const res = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "Pothole" });
    expect(res.status).toBe(400);
  });

  it("POST /problem/problems without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/problem/problems")
      .send({ title: "T", description: "D", affectedArea: "A", jurisdictionId: randomUUID() });
    expect(res.status).toBe(401);
  });

  it("POST /problem/problems rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-carol", legalIdentifier: "id-pending-carol" });

    const res = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", registerRes.body.id)
      .send({ title: "T", description: "D", affectedArea: "A", jurisdictionId: randomUUID() });
    expect(res.status).toBe(403);
  });

  it("GET /problem/problems/:id returns 404 for a missing problem", async () => {
    const res = await request(app.getHttpServer()).get("/problem/problems/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("GET /problem/problems lists problems publicly (FR-016)", async () => {
    const citizenId = await activeCitizen("dana");
    const jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "A", description: "D", affectedArea: "Area", jurisdictionId });

    const res = await request(app.getHttpServer()).get("/problem/problems");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /problem/problems/:id/support endorses the problem for a jurisdiction member (DP-004)", async () => {
    const citizenId = await activeCitizen("erin");
    const jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    const createRes = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "T", description: "D", affectedArea: "A", jurisdictionId });

    const endorserId = await activeCitizen("frank");
    await insertMembership(endorserId, jurisdictionId);

    const res = await request(app.getHttpServer())
      .post(`/problem/problems/${createRes.body.id}/support`)
      .set("x-citizen-id", endorserId);
    expect(res.status).toBe(201);
    expect(res.body.support.citizenId).toBe(endorserId);
    expect(res.body.problem.id).toBe(createRes.body.id);
  });

  it("POST /problem/problems/:id/support is 403 when the citizen is not a jurisdiction member", async () => {
    const citizenId = await activeCitizen("gabe");
    const jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    const createRes = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "T", description: "D", affectedArea: "A", jurisdictionId });

    const nonMemberId = await activeCitizen("hana");
    const res = await request(app.getHttpServer())
      .post(`/problem/problems/${createRes.body.id}/support`)
      .set("x-citizen-id", nonMemberId);
    expect(res.status).toBe(403);
  });

  it("POST /problem/problems/:id/support without x-citizen-id is 401", async () => {
    const citizenId = await activeCitizen("ivan");
    const jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    const createRes = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "T", description: "D", affectedArea: "A", jurisdictionId });

    const res = await request(app.getHttpServer()).post(`/problem/problems/${createRes.body.id}/support`);
    expect(res.status).toBe(401);
  });

  it("POST /problem/problems/:id/support is 409 on a duplicate endorsement", async () => {
    const citizenId = await activeCitizen("julia");
    const jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    const createRes = await request(app.getHttpServer())
      .post("/problem/problems")
      .set("x-citizen-id", citizenId)
      .send({ title: "T", description: "D", affectedArea: "A", jurisdictionId });

    const endorserId = await activeCitizen("kim");
    await insertMembership(endorserId, jurisdictionId);

    await request(app.getHttpServer())
      .post(`/problem/problems/${createRes.body.id}/support`)
      .set("x-citizen-id", endorserId);
    const res = await request(app.getHttpServer())
      .post(`/problem/problems/${createRes.body.id}/support`)
      .set("x-citizen-id", endorserId);
    expect(res.status).toBe(409);
  });

  it("POST /problem/problems/:id/support is 404 for a missing problem", async () => {
    const citizenId = await activeCitizen("liam");
    const res = await request(app.getHttpServer())
      .post("/problem/problems/00000000-0000-0000-0000-000000000000/support")
      .set("x-citizen-id", citizenId);
    expect(res.status).toBe(404);
  });
});
