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
import { ProposalModule } from "./proposal.module.js";

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

async function insertCitizen(id: string, publicHandle: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO citizen (id, public_handle, legal_identity_hash) VALUES ($1, $2, $3)`, [
      id,
      publicHandle,
      `hash-${id}`,
    ]),
  );
}

async function insertJurisdiction(id: string, name: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO jurisdiction (id, name, scope_level, boundary_ref, population) VALUES ($1, $2, 'municipality', $3, 200)`,
      [id, name, `ref-${id}`],
    ),
  );
}

async function insertProblem(id: string, authorId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO problem (id, author_id, title, description, affected_area, jurisdiction_id)
       VALUES ($1, $2, 'Potholes', 'Too many potholes', 'Main St', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

async function insertJurisdictionMembership(citizenId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction_membership (id, citizen_id, jurisdiction_id) VALUES ($1, $2, $3)`, [
      randomUUID(),
      citizenId,
      jurisdictionId,
    ]),
  );
}

async function updateProposalStatus(id: string, status: string): Promise<void> {
  await withAdmin((client) => client.query(`UPDATE proposal SET status = $1 WHERE id = $2`, [status, id]));
}

async function updateProposalScopeJurisdiction(id: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`UPDATE proposal SET scope_jurisdiction_id = $1 WHERE id = $2`, [jurisdictionId, id]),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, ProposalModule's own imports plus
// the transitively-imported IdentityModule's/JurisdictionModule's) points
// every module's Prisma calls at the same test database, so this exercises
// the real controller -> service -> Postgres/RLS stack end to end instead of
// swapping in per-module in-memory repositories -- including
// CITIZEN_STATUS_CHECKER (IdentityService) and JURISDICTION_MEMBERSHIP_CHECKER
// (JurisdictionService), which now run for real against seeded rows rather
// than the fakes this spec used to install.
describe.skipIf(!urls)("ProposalController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jurisdictionId: string;
  let problemId: string;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const problemAuthorId = randomUUID();
    await insertCitizen(problemAuthorId, "problem-author");
    jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    problemId = randomUUID();
    await insertProblem(problemId, problemAuthorId, jurisdictionId);

    const moduleRef = await Test.createTestingModule({ imports: [ProposalModule] })
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
  // imported) IdentityModule routes, exactly like budget.controller.e2e.spec.ts's flow.
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

  it("POST /proposal/proposals creates a draft proposal (DP-005)", async () => {
    const citizenId = await activeCitizen("alice");
    const res = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "Fix it", description: "Details" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.authorId).toBe(citizenId);
  });

  it("POST /proposal/proposals rejects an invalid body", async () => {
    const citizenId = await activeCitizen("bob");
    const res = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ title: "Fix it" });
    expect(res.status).toBe(400);
  });

  it("POST /proposal/proposals without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .send({ problemId, title: "Fix it", description: "Details" });
    expect(res.status).toBe(401);
  });

  it("POST /proposal/proposals rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-carol", legalIdentifier: "id-pending-carol" });

    const res = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", registerRes.body.id)
      .send({ problemId, title: "Fix it", description: "Details" });
    expect(res.status).toBe(403);
  });

  it("GET /proposal/proposals/:id returns 404 for a missing proposal", async () => {
    const res = await request(app.getHttpServer()).get(`/proposal/proposals/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("GET /proposal/proposals lists proposals, optionally filtered by problemId (FR-018)", async () => {
    const citizenId = await activeCitizen("dana");
    const problemId1 = randomUUID();
    const problemId2 = randomUUID();
    await insertProblem(problemId1, citizenId, jurisdictionId);
    await insertProblem(problemId2, citizenId, jurisdictionId);
    await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId: problemId1, title: "A", description: "D" });
    await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId: problemId2, title: "B", description: "D" });

    const filtered = await request(app.getHttpServer()).get("/proposal/proposals").query({ problemId: problemId1 });
    expect(filtered.status).toBe(200);
    expect(filtered.body.every((p: { problemId: string }) => p.problemId === problemId1)).toBe(true);
    expect(filtered.body.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /proposal/proposals/:id/constraints adds a constraint for the author (DP-006)", async () => {
    const citizenId = await activeCitizen("erin");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "T", description: "D" });

    const res = await request(app.getHttpServer())
      .post(`/proposal/proposals/${createRes.body.id}/constraints`)
      .set("x-citizen-id", citizenId)
      .send({ text: "must not raise taxes" });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe("must not raise taxes");
  });

  it("POST /proposal/proposals/:id/constraints is 403 for a non-author", async () => {
    const author = await activeCitizen("frank");
    const intruder = await activeCitizen("gabe");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", author)
      .send({ problemId, title: "T", description: "D" });

    const res = await request(app.getHttpServer())
      .post(`/proposal/proposals/${createRes.body.id}/constraints`)
      .set("x-citizen-id", intruder)
      .send({ text: "x" });
    expect(res.status).toBe(403);
  });

  it("POST /proposal/proposals/:id/constraints is 422 once the proposal has left the addable statuses", async () => {
    const author = await activeCitizen("hana");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", author)
      .send({ problemId, title: "T", description: "D" });

    await updateProposalStatus(createRes.body.id, "voting");

    const res = await request(app.getHttpServer())
      .post(`/proposal/proposals/${createRes.body.id}/constraints`)
      .set("x-citizen-id", author)
      .send({ text: "x" });
    expect(res.status).toBe(422);
  });

  it("GET /proposal/proposals/:id/constraints is public and lists every constraint (EPIC-005)", async () => {
    const citizenId = await activeCitizen("kara");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "T", description: "D" });
    await request(app.getHttpServer())
      .post(`/proposal/proposals/${createRes.body.id}/constraints`)
      .set("x-citizen-id", citizenId)
      .send({ text: "must not raise taxes" });

    const res = await request(app.getHttpServer()).get(`/proposal/proposals/${createRes.body.id}/constraints`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].text).toBe("must not raise taxes");
  });

  it("POST /proposal/proposals/:id/budget creates and updates budget info for the author (DP-007)", async () => {
    const citizenId = await activeCitizen("ivan");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "T", description: "D" });

    const res = await request(app.getHttpServer())
      .post(`/proposal/proposals/${createRes.body.id}/budget`)
      .set("x-citizen-id", citizenId)
      .send({ cost: 1000, fundingSource: "grant" });
    expect(res.status).toBe(201);
    expect(res.body.cost).toBe(1000);
  });

  it("GET /proposal/proposals/:id/budget is public and returns null before any budget info is submitted, then the row after (US-028)", async () => {
    const citizenId = await activeCitizen("liam");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "T", description: "D" });

    const before = await request(app.getHttpServer()).get(`/proposal/proposals/${createRes.body.id}/budget`);
    expect(before.status).toBe(200);
    // Nest sends an empty body (not the JSON literal `null`) for a `null`
    // controller return -- falsy either way for a client checking "has this
    // proposal's author submitted budget info yet".
    expect(before.text).toBe("");

    await request(app.getHttpServer())
      .post(`/proposal/proposals/${createRes.body.id}/budget`)
      .set("x-citizen-id", citizenId)
      .send({ cost: 2000, longTermCost: 300 });

    const after = await request(app.getHttpServer()).get(`/proposal/proposals/${createRes.body.id}/budget`);
    expect(after.status).toBe(200);
    expect(after.body.cost).toBe(2000);
    expect(after.body.longTermCost).toBe(300);
  });

  it("POST /proposal/scope-challenges is 422 when no scope jurisdiction is assigned (DP-020)", async () => {
    const citizenId = await activeCitizen("julia");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "T", description: "D" });

    const res = await request(app.getHttpServer())
      .post("/proposal/scope-challenges")
      .set("x-citizen-id", citizenId)
      .send({ proposalId: createRes.body.id, reason: "scope looks wrong" });
    expect(res.status).toBe(422);
  });

  it("POST /proposal/scope-challenges succeeds for an affected citizen once a scope is assigned", async () => {
    const citizenId = await activeCitizen("kim");
    const createRes = await request(app.getHttpServer())
      .post("/proposal/proposals")
      .set("x-citizen-id", citizenId)
      .send({ problemId, title: "T", description: "D" });

    await updateProposalScopeJurisdiction(createRes.body.id, jurisdictionId);
    // jurisdiction_membership makes the real JurisdictionService.isAffected
    // resolve true via isMember (jurisdiction-membership.port.ts) -- stands
    // in for the old fake's `affected.add(...)`.
    await insertJurisdictionMembership(citizenId, jurisdictionId);

    const res = await request(app.getHttpServer())
      .post("/proposal/scope-challenges")
      .set("x-citizen-id", citizenId)
      .send({ proposalId: createRes.body.id, reason: "scope looks wrong" });
    expect(res.status).toBe(201);
    expect(res.body.scopeChallengedAt).not.toBeNull();
  });
});
