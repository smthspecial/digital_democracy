import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_EMITTER } from "../common/audit-emitter.js";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { NOTIFICATION_EMITTER } from "../common/notification-emitter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { ProjectModule } from "./project.module.js";

const urls = testDatabaseUrls();

const OVERSIGHT = randomUUID();
const AUDITOR = randomUUID();
const NOBODY = randomUUID();
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

async function insertGovernanceRole(id: string, citizenId: string, roleType: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO governance_role (id, citizen_id, role_type, layer, term_start, term_end, randomized)
       VALUES ($1, $2, $3, 'audit', '2020-01-01', '2999-01-01', false)`,
      [id, citizenId, roleType],
    ),
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
       VALUES ($1, $2, 'Potholes', 'Too many potholes', 'Main St', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

async function insertProposal(id: string, problemId: string, authorId: string, scopeJurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO proposal (id, problem_id, author_id, title, description, scope_jurisdiction_id, support_threshold)
       VALUES ($1, $2, $3, 'Repave Main St', 'Repave the road', $4, 100)`,
      [id, problemId, authorId, scopeJurisdictionId],
    ),
  );
}

async function insertProject(id: string, proposalId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO project (id, proposal_id, timeline_start, timeline_end, contractor)
       VALUES ($1, $2, '2026-01-01', '2026-12-31', 'Acme Co')`,
      [id, proposalId],
    ),
  );
}

async function insertMilestone(id: string, projectId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO project_milestone (id, project_id, name, due_date) VALUES ($1, $2, 'Phase 1', '2026-06-01')`, [
      id,
      projectId,
    ]),
  );
}

async function findLedgerEntries(): Promise<Array<{ jurisdiction_id: string; amount: string; project_id: string | null }>> {
  return withAdmin(async (client) => {
    const res = await client.query(`SELECT jurisdiction_id, amount, project_id FROM ledger_entry`);
    return res.rows;
  });
}

async function findReputationRecords(citizenId: string): Promise<Array<{ factor_type: string; delta: string }>> {
  return withAdmin(async (client) => {
    const res = await client.query(`SELECT factor_type, delta FROM reputation_record WHERE citizen_id = $1`, [citizenId]);
    return res.rows;
  });
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, ProjectModule's own imports plus
// GovernanceRoleModule/BudgetModule/ReputationModule's) points every
// module's Prisma calls at the same test database, so this exercises the
// real controller -> service -> Postgres/RLS stack end to end instead of
// swapping in per-module in-memory repositories.
describe.skipIf(!urls)("ProjectController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jurisdictionId: string;
  let projectId: string;
  let milestoneId: string;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    await insertCitizen(OVERSIGHT, "oversight-1");
    await insertCitizen(AUDITOR, "auditor-1");
    await insertCitizen(PROPOSAL_AUTHOR, "author-1");
    await insertGovernanceRole(randomUUID(), OVERSIGHT, "oversight");
    await insertGovernanceRole(randomUUID(), AUDITOR, "auditor");

    jurisdictionId = randomUUID();
    const problemId = randomUUID();
    const proposalId = randomUUID();
    projectId = randomUUID();
    milestoneId = randomUUID();

    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertProblem(problemId, PROPOSAL_AUTHOR, jurisdictionId);
    await insertProposal(proposalId, problemId, PROPOSAL_AUTHOR, jurisdictionId);
    await insertProject(projectId, proposalId);
    await insertMilestone(milestoneId, projectId);

    const moduleRef = await Test.createTestingModule({ imports: [ProjectModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AUDIT_EMITTER)
      .useValue({ emit: async () => undefined })
      .overrideProvider(NOTIFICATION_EMITTER)
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

  it("GET /projects is public and lists projects", async () => {
    const res = await request(app.getHttpServer()).get("/projects");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("GET /projects/:id/milestones is public", async () => {
    const res = await request(app.getHttpServer()).get(`/projects/${projectId}/milestones`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("PATCH /projects/milestones/:id without an oversight/operator role is 403", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/projects/milestones/${milestoneId}`)
      .set("x-citizen-id", NOBODY)
      .send({ status: "done" });
    expect(res.status).toBe(403);
  });

  it("PATCH /projects/milestones/:id with a spend delta pushes a ledger entry", async () => {
    const res = await request(app.getHttpServer())
      .patch(`/projects/milestones/${milestoneId}`)
      .set("x-citizen-id", OVERSIGHT)
      .send({ status: "pending", spentDelta: 500 });
    expect(res.status).toBe(200);

    const ledgerEntries = await findLedgerEntries();
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].jurisdiction_id).toBe(jurisdictionId);
    expect(Number(ledgerEntries[0].amount)).toBe(500);
  });

  it("POST /projects/:id/evaluations without an auditor/oversight role is 403", async () => {
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/evaluations`)
      .set("x-citizen-id", NOBODY)
      .send({ objective: "x", promisedOutcome: "y", measuredOutcome: "z", evaluation: "successful" });
    expect(res.status).toBe(403);
  });

  it("POST /projects/:id/evaluations on a successful outcome records a reputation delta for the proposal author", async () => {
    const res = await request(app.getHttpServer())
      .post(`/projects/${projectId}/evaluations`)
      .set("x-citizen-id", AUDITOR)
      .send({
        objective: "Reduce commute times",
        promisedOutcome: "20% faster commutes",
        measuredOutcome: "22% faster commutes",
        evaluation: "successful",
      });
    expect(res.status).toBe(201);

    const records = await findReputationRecords(PROPOSAL_AUTHOR);
    expect(records).toHaveLength(1);
    expect(records[0].factor_type).toBe("successful_proposal");
  });

  it("GET /projects/no-such-id is 404", async () => {
    const res = await request(app.getHttpServer()).get(`/projects/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
