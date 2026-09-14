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
import { BudgetModule } from "./budget.module.js";

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

async function insertCategory(id: string, jurisdictionId: string, name: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO budget_category (id, jurisdiction_id, name) VALUES ($1, $2, $3)`, [
      id,
      jurisdictionId,
      name,
    ]),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, BudgetModule's own imports plus the
// transitively-imported IdentityModule's) points every module's Prisma
// calls at the same test database, so this exercises the real controller ->
// service -> Postgres/RLS stack end to end instead of swapping in
// per-module in-memory repositories.
describe.skipIf(!urls)("BudgetController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let jurisdictionId: string;
  let categoryId: string;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    jurisdictionId = randomUUID();
    categoryId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertCategory(categoryId, jurisdictionId, "Healthcare");

    const moduleRef = await Test.createTestingModule({ imports: [BudgetModule] })
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

  it("GET /budget/categories is public, optionally filtered by jurisdictionId", async () => {
    const res = await request(app.getHttpServer()).get("/budget/categories");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);

    const filtered = await request(app.getHttpServer()).get("/budget/categories").query({ jurisdictionId });
    expect(filtered.body).toHaveLength(1);

    const empty = await request(app.getHttpServer()).get("/budget/categories").query({ jurisdictionId: randomUUID() });
    expect(empty.body).toHaveLength(0);
  });

  it("POST /budget/budget-votes submits an allocation for the active citizen (DP-013)", async () => {
    const citizenId = await activeCitizen("alice");
    const res = await request(app.getHttpServer())
      .post("/budget/budget-votes")
      .set("x-citizen-id", citizenId)
      .send({ period: "2026-Q3", allocations: [{ categoryId, percentage: 100 }] });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].citizenId).toBe(citizenId);
    expect(res.body[0].percentage).toBe(100);
  });

  it("POST /budget/budget-votes rejects an invalid body (missing allocations)", async () => {
    const citizenId = await activeCitizen("bob");
    const res = await request(app.getHttpServer())
      .post("/budget/budget-votes")
      .set("x-citizen-id", citizenId)
      .send({ period: "2026-Q3" });
    expect(res.status).toBe(400);
  });

  it("POST /budget/budget-votes rejects totals that don't sum to 100 with 422 (AUTH-010 totals:100)", async () => {
    const citizenId = await activeCitizen("carol");
    const res = await request(app.getHttpServer())
      .post("/budget/budget-votes")
      .set("x-citizen-id", citizenId)
      .send({ period: "2026-Q3", allocations: [{ categoryId, percentage: 40 }] });
    expect(res.status).toBe(422);
  });

  it("POST /budget/budget-votes without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/budget/budget-votes")
      .send({ period: "2026-Q3", allocations: [] });
    expect(res.status).toBe(401);
  });

  it("POST /budget/budget-votes rejects an inactive citizen with 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-dana", legalIdentifier: "id-pending-dana" });

    const res = await request(app.getHttpServer())
      .post("/budget/budget-votes")
      .set("x-citizen-id", registerRes.body.id)
      .send({ period: "2026-Q3", allocations: [{ categoryId, percentage: 100 }] });
    expect(res.status).toBe(403);
  });

  it("GET /budget/budget-votes without ?period= is 400 (does not silently return everything)", async () => {
    const citizenId = await activeCitizen("erin");
    const res = await request(app.getHttpServer()).get("/budget/budget-votes").set("x-citizen-id", citizenId);
    expect(res.status).toBe(400);
  });

  it("GET /budget/budget-votes without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer()).get("/budget/budget-votes").query({ period: "2026-Q3" });
    expect(res.status).toBe(401);
  });

  it("GET /budget/budget-votes returns only the calling citizen's own allocation for the period", async () => {
    const citizenId = await activeCitizen("frank");
    await request(app.getHttpServer())
      .post("/budget/budget-votes")
      .set("x-citizen-id", citizenId)
      .send({ period: "2026-Q3", allocations: [{ categoryId, percentage: 100 }] });

    const res = await request(app.getHttpServer())
      .get("/budget/budget-votes")
      .set("x-citizen-id", citizenId)
      .query({ period: "2026-Q3" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].citizenId).toBe(citizenId);
  });

  it("GET /budget/ledger is public, optionally filtered", async () => {
    const res = await request(app.getHttpServer()).get("/budget/ledger");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // Scope decision (SRV-007 task brief): DP-019 is a service-layer-only
  // capability, never exposed over HTTP -- confirm the route genuinely
  // doesn't exist, not merely undocumented.
  it("there is no POST /budget/ledger route -- DP-019 is not exposed over HTTP", async () => {
    const res = await request(app.getHttpServer())
      .post("/budget/ledger")
      .send({
        jurisdictionId,
        direction: "inflow",
        amount: 100,
        source: "tax",
        occurredAt: new Date().toISOString(),
      });
    expect(res.status).toBe(404);
  });
});
