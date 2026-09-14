import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { CompetencyModule } from "./competency.module.js";

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

async function insertDomain(id: string, name: string, description = "Scope"): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO expert_domain (id, name, description) VALUES ($1, $2, $3)`, [id, name, description]),
  );
}

async function insertCompetency(
  id: string,
  citizenId: string,
  domainId: string,
  status: "applied" | "active" = "active",
): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO competency (id, citizen_id, domain_id, level, status) VALUES ($1, $2, $3, 2, $4)`, [
      id,
      citizenId,
      domainId,
      status,
    ]),
  );
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

async function insertProblem(id: string, authorId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO problem (id, author_id, title, description, affected_area, jurisdiction_id)
       VALUES ($1, $2, 'Problem', 'Description', 'Area', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

async function insertProposal(id: string, problemId: string, authorId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO proposal (id, problem_id, author_id, title, description, support_threshold)
       VALUES ($1, $2, $3, 'Proposal', 'Description', 10)`,
      [id, problemId, authorId],
    ),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, CompetencyModule's own imports plus
// IdentityModule's) points every module's Prisma calls at the same test
// database, so this exercises the real controller -> service -> Postgres/RLS
// stack end to end instead of swapping in per-module in-memory repositories.
describe.skipIf(!urls)("CompetencyController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [CompetencyModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
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

  it("GET /competency/domains lists the public domain catalog", async () => {
    const domainId = randomUUID();
    await insertDomain(domainId, "Transportation", "Roads");
    const res = await request(app.getHttpServer()).get("/competency/domains");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: domainId, name: "Transportation", description: "Roads" }]);
  });

  it("POST /competency/competencies creates an applied competency (DP-011)", async () => {
    const citizenId = await activeCitizen("alice");
    const domainId = randomUUID();
    await insertDomain(domainId, "Housing");
    const res = await request(app.getHttpServer())
      .post("/competency/competencies")
      .set("x-citizen-id", citizenId)
      .send({ domainId, level: 2 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("applied");
    expect(res.body.citizenId).toBe(citizenId);
  });

  it("POST /competency/competencies rejects an invalid body", async () => {
    const citizenId = await activeCitizen("bob");
    const res = await request(app.getHttpServer())
      .post("/competency/competencies")
      .set("x-citizen-id", citizenId)
      .send({ domainId: "not-a-uuid", level: 9 });
    expect(res.status).toBe(400);
  });

  it("POST /competency/competencies without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/competency/competencies")
      .send({ domainId: randomUUID(), level: 1 });
    expect(res.status).toBe(401);
  });

  it("POST /competency/competencies rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-carol", legalIdentifier: "id-pending-carol" });

    const res = await request(app.getHttpServer())
      .post("/competency/competencies")
      .set("x-citizen-id", registerRes.body.id)
      .send({ domainId: randomUUID(), level: 1 });
    expect(res.status).toBe(403);
  });

  it("GET /competency/competencies lists competencies, optionally filtered by citizenId/domainId", async () => {
    const citizenId = await activeCitizen("dana");
    const domainId1 = randomUUID();
    const domainId2 = randomUUID();
    await insertDomain(domainId1, "Water");
    await insertDomain(domainId2, "Energy");
    await request(app.getHttpServer())
      .post("/competency/competencies")
      .set("x-citizen-id", citizenId)
      .send({ domainId: domainId1, level: 1 });
    await request(app.getHttpServer())
      .post("/competency/competencies")
      .set("x-citizen-id", citizenId)
      .send({ domainId: domainId2, level: 1 });

    const filtered = await request(app.getHttpServer())
      .get("/competency/competencies")
      .query({ domainId: domainId1 });
    expect(filtered.status).toBe(200);
    expect(filtered.body.every((c: { domainId: string }) => c.domainId === domainId1)).toBe(true);
    expect(filtered.body.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /competency/conflicts declares a conflict of interest (DP-010)", async () => {
    const citizenId = await activeCitizen("erin");
    const domainId = randomUUID();
    await insertDomain(domainId, "Parks");
    const res = await request(app.getHttpServer())
      .post("/competency/conflicts")
      .set("x-citizen-id", citizenId)
      .send({
        domainId,
        type: "employer",
        description: "Works for a firm in this domain",
      });

    expect(res.status).toBe(201);
    expect(res.body.citizenId).toBe(citizenId);
    expect(res.body.type).toBe("employer");
  });

  it("POST /competency/conflicts rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-frank", legalIdentifier: "id-pending-frank" });

    const res = await request(app.getHttpServer())
      .post("/competency/conflicts")
      .set("x-citizen-id", registerRes.body.id)
      .send({ domainId: randomUUID(), type: "financial", description: "x" });
    expect(res.status).toBe(403);
  });

  it("POST /competency/competency-challenges submits a challenge (DP-012)", async () => {
    const challenger = await activeCitizen("gabe");
    const domainId = randomUUID();
    await insertDomain(domainId, "Transit");
    const competencyId = randomUUID();
    await insertCompetency(competencyId, challenger, domainId, "applied");

    const res = await request(app.getHttpServer())
      .post("/competency/competency-challenges")
      .set("x-citizen-id", challenger)
      .send({
        competencyId,
        evidenceRef: "evidence-ref-1",
        reason: "credentials",
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("open");
    expect(res.body.challengerId).toBe(challenger);
  });

  it("POST /competency/competency-challenges rejects a missing evidenceRef with 400", async () => {
    const challenger = await activeCitizen("hana");
    const res = await request(app.getHttpServer())
      .post("/competency/competency-challenges")
      .set("x-citizen-id", challenger)
      .send({ competencyId: randomUUID(), evidenceRef: "", reason: "credentials" });
    expect(res.status).toBe(400);
  });

  it("POST /competency/assessments is 403 with no active competency in the domain (DP-021)", async () => {
    const citizenId = await activeCitizen("ivan");
    const res = await request(app.getHttpServer())
      .post("/competency/assessments")
      .set("x-citizen-id", citizenId)
      .send({
        proposalId: randomUUID(),
        domainId: randomUUID(),
        technicalScore: 5,
        economicScore: 5,
        socialScore: 5,
        sustainabilityScore: 5,
        body: "Analysis",
      });
    expect(res.status).toBe(403);
  });

  it("POST /competency/assessments is 403 when a conflict of interest exists in the domain, even with active competency there", async () => {
    const citizenId = await activeCitizen("julia");
    const domainId = randomUUID();
    await insertDomain(domainId, "Sanitation");
    await insertCompetency(randomUUID(), citizenId, domainId, "active");
    await request(app.getHttpServer())
      .post("/competency/conflicts")
      .set("x-citizen-id", citizenId)
      .send({ domainId, type: "consulting", description: "Undisclosed-turned-disclosed interest" });

    const res = await request(app.getHttpServer())
      .post("/competency/assessments")
      .set("x-citizen-id", citizenId)
      .send({
        proposalId: randomUUID(),
        domainId,
        technicalScore: 5,
        economicScore: 5,
        socialScore: 5,
        sustainabilityScore: 5,
        body: "Analysis",
      });
    expect(res.status).toBe(403);
  });

  it("POST /competency/assessments succeeds with an active competency and no conflict, then is listed via GET (DP-021)", async () => {
    const citizenId = await activeCitizen("kim");
    const domainId = randomUUID();
    await insertDomain(domainId, "Education");
    await insertCompetency(randomUUID(), citizenId, domainId, "active");

    const jurisdictionId = randomUUID();
    const problemId = randomUUID();
    const proposalId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertProblem(problemId, citizenId, jurisdictionId);
    await insertProposal(proposalId, problemId, citizenId);

    const res = await request(app.getHttpServer())
      .post("/competency/assessments")
      .set("x-citizen-id", citizenId)
      .send({
        proposalId,
        domainId,
        technicalScore: 8,
        economicScore: 7,
        socialScore: 6,
        sustainabilityScore: 9,
        body: "This proposal holds up technically.",
      });
    expect(res.status).toBe(201);
    expect(res.body.expertId).toBe(citizenId);

    const listed = await request(app.getHttpServer()).get("/competency/assessments").query({ proposalId });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].expertId).toBe(citizenId);
  });
});
