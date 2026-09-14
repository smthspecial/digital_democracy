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
import { ReputationModule } from "./reputation.module.js";

const urls = testDatabaseUrls();

const CITIZEN_1 = randomUUID();
const CITIZEN_2 = randomUUID();

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

// reputation_record's INSERT policy is api_worker-only (DP-038) -- seeded
// directly here (via the admin connection, which bypasses RLS) since there
// is no POST /reputation/records route to seed through, mirroring how
// project.controller.e2e.spec.ts seeds project_milestone/outcome_evaluation
// (also api_worker-only writes) via raw SQL rather than the HTTP API.
async function insertReputationRecord(
  id: string,
  citizenId: string,
  factorType: string,
  delta: number,
  reason: string,
): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO reputation_record (id, citizen_id, factor_type, delta, reason) VALUES ($1, $2, $3, $4, $5)`,
      [id, citizenId, factorType, delta, reason],
    ),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override points
// ReputationModule's Prisma calls at the same test database, so this
// exercises the real controller -> service -> Postgres/RLS stack end to end
// instead of swapping in an in-memory repository. Self-contained (doesn't
// import any other module's repository), mirroring project.controller.e2e.spec.ts.
describe.skipIf(!urls)("ReputationController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    await insertCitizen(CITIZEN_1, "alice");
    await insertCitizen(CITIZEN_2, "bob");

    const moduleRef = await Test.createTestingModule({ imports: [ReputationModule] })
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

    await insertReputationRecord(randomUUID(), CITIZEN_1, "disclosure", 2, "Disclosed COI");
    await insertReputationRecord(randomUUID(), CITIZEN_2, "fraud", -10, "Fraud finding");
  });

  afterAll(async () => {
    await app.close();
    await prisma?.onModuleDestroy();
  });

  it("GET /reputation/records is public and unfiltered returns every citizen's records", async () => {
    const res = await request(app.getHttpServer()).get("/reputation/records");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it("GET /reputation/records?citizenId= filters to one citizen's records", async () => {
    const res = await request(app.getHttpServer()).get("/reputation/records").query({ citizenId: CITIZEN_2 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].citizenId).toBe(CITIZEN_2);
  });

  // Scope decision (mirrors budget/ledger's own DP-019 precedent): DP-038
  // ("Reputation score update") is a service-layer-only capability, never
  // exposed over HTTP -- self-reported deltas are not permitted.
  it("there is no POST /reputation/records route -- DP-038 is not exposed over HTTP", async () => {
    const res = await request(app.getHttpServer())
      .post("/reputation/records")
      .send({ citizenId: CITIZEN_1, factorType: "successful_proposal", delta: 5, reason: "x" });
    expect(res.status).toBe(404);
  });
});
