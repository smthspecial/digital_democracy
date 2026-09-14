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
import { DeliberationModule } from "./deliberation.module.js";

process.env.IDENTITY_HASH_SECRET ??= "test-secret";

const urls = testDatabaseUrls();

const PROPOSAL_AUTHOR = randomUUID();

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
// graph shares that one @Global token, DeliberationModule's own imports
// plus the transitively imported IdentityModule's) points every module's
// Prisma calls at the same test database, so this exercises the real
// controller -> service -> Postgres/RLS stack end to end instead of
// swapping in per-module in-memory repositories. deliberation_argument.proposal_id
// and preference.problem_id are real FKs now, so tests that expect a 201
// seed a real proposal/problem via the admin connection first (mirrors
// project.controller.e2e.spec.ts).
describe.skipIf(!urls)("DeliberationController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jurisdictionId: string;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    await insertCitizen(PROPOSAL_AUTHOR, "author-1");
    jurisdictionId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");

    const moduleRef = await Test.createTestingModule({ imports: [DeliberationModule] })
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
  // imported) IdentityModule routes, exactly like proposal/problem's e2e
  // spec files' flow.
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

  async function seedProposal(): Promise<string> {
    const problemId = randomUUID();
    const proposalId = randomUUID();
    await insertProblem(problemId, PROPOSAL_AUTHOR, jurisdictionId);
    await insertProposal(proposalId, problemId, PROPOSAL_AUTHOR);
    return proposalId;
  }

  async function seedProblem(): Promise<string> {
    const problemId = randomUUID();
    await insertProblem(problemId, PROPOSAL_AUTHOR, jurisdictionId);
    return problemId;
  }

  it("POST /deliberation/arguments posts an argument (DP-008)", async () => {
    const citizenId = await activeCitizen("alice");
    const proposalId = await seedProposal();
    const res = await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .set("x-citizen-id", citizenId)
      .send({ proposalId, stance: "agreement", body: "Good idea", evidenceRef: "study-1" });

    expect(res.status).toBe(201);
    expect(res.body.authorId).toBe(citizenId);
    expect(res.body.stance).toBe("agreement");
  });

  it("POST /deliberation/arguments rejects a body missing evidenceRef (FR-028)", async () => {
    const citizenId = await activeCitizen("bob");
    const res = await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .set("x-citizen-id", citizenId)
      .send({ proposalId: randomUUID(), stance: "agreement", body: "Good idea" });
    expect(res.status).toBe(400);
  });

  it("POST /deliberation/arguments rejects an invalid stance", async () => {
    const citizenId = await activeCitizen("cleo");
    const res = await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .set("x-citizen-id", citizenId)
      .send({ proposalId: randomUUID(), stance: "neutral", body: "x", evidenceRef: "e" });
    expect(res.status).toBe(400);
  });

  it("POST /deliberation/arguments without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .send({ proposalId: randomUUID(), stance: "agreement", body: "x", evidenceRef: "e" });
    expect(res.status).toBe(401);
  });

  it("POST /deliberation/arguments rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-dana", legalIdentifier: "id-pending-dana" });

    const res = await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .set("x-citizen-id", registerRes.body.id)
      .send({ proposalId: randomUUID(), stance: "agreement", body: "x", evidenceRef: "e" });
    expect(res.status).toBe(403);
  });

  it("GET /deliberation/arguments lists arguments, optionally filtered by proposalId", async () => {
    const citizenId = await activeCitizen("erin");
    const proposalId1 = await seedProposal();
    const proposalId2 = await seedProposal();
    await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .set("x-citizen-id", citizenId)
      .send({ proposalId: proposalId1, stance: "agreement", body: "a", evidenceRef: "e" });
    await request(app.getHttpServer())
      .post("/deliberation/arguments")
      .set("x-citizen-id", citizenId)
      .send({ proposalId: proposalId2, stance: "disagreement", body: "b", evidenceRef: "e" });

    const filtered = await request(app.getHttpServer())
      .get("/deliberation/arguments")
      .query({ proposalId: proposalId1 });
    expect(filtered.status).toBe(200);
    expect(filtered.body.every((a: { proposalId: string }) => a.proposalId === proposalId1)).toBe(true);
    expect(filtered.body.length).toBeGreaterThanOrEqual(1);
  });

  it("POST /deliberation/preferences declares a preference (DP-009)", async () => {
    const citizenId = await activeCitizen("frank");
    const problemId = await seedProblem();
    const res = await request(app.getHttpServer())
      .post("/deliberation/preferences")
      .set("x-citizen-id", citizenId)
      .send({ problemId, desiredOutcome: "Fewer potholes" });

    expect(res.status).toBe(201);
    expect(res.body.citizenId).toBe(citizenId);
    expect(res.body.desiredOutcome).toBe("Fewer potholes");
  });

  it("POST /deliberation/preferences rejects an invalid body", async () => {
    const citizenId = await activeCitizen("gabe");
    const res = await request(app.getHttpServer())
      .post("/deliberation/preferences")
      .set("x-citizen-id", citizenId)
      .send({ desiredOutcome: "x" });
    expect(res.status).toBe(400);
  });

  it("POST /deliberation/preferences without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/deliberation/preferences")
      .send({ problemId: randomUUID(), desiredOutcome: "x" });
    expect(res.status).toBe(401);
  });

  it("POST /deliberation/preferences rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-hana", legalIdentifier: "id-pending-hana" });

    const res = await request(app.getHttpServer())
      .post("/deliberation/preferences")
      .set("x-citizen-id", registerRes.body.id)
      .send({ problemId: randomUUID(), desiredOutcome: "x" });
    expect(res.status).toBe(403);
  });

  it("GET /deliberation/preferences lists preferences, optionally filtered by problemId", async () => {
    const citizenId = await activeCitizen("ivan");
    const problemId1 = await seedProblem();
    const problemId2 = await seedProblem();
    await request(app.getHttpServer())
      .post("/deliberation/preferences")
      .set("x-citizen-id", citizenId)
      .send({ problemId: problemId1, desiredOutcome: "a" });
    await request(app.getHttpServer())
      .post("/deliberation/preferences")
      .set("x-citizen-id", citizenId)
      .send({ problemId: problemId2, desiredOutcome: "b" });

    const filtered = await request(app.getHttpServer())
      .get("/deliberation/preferences")
      .query({ problemId: problemId1 });
    expect(filtered.status).toBe(200);
    expect(filtered.body.every((p: { problemId: string }) => p.problemId === problemId1)).toBe(true);
    expect(filtered.body.length).toBeGreaterThanOrEqual(1);
  });
});
