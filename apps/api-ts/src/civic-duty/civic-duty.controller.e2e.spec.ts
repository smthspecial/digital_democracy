import { randomUUID } from "node:crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainErrorFilter } from "../common/domain-error.filter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { CivicDutyModule } from "./civic-duty.module.js";

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

// No citizen-facing (or worker-facing) create op exists for civic_assignment/
// participation_record in this pass (DP-040/DP-048, out of scope) --
// fixtures go in directly via the admin connection, mirroring
// budget_category's own precedent.
async function insertAssignment(id: string, citizenId: string, status = "assigned"): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO civic_assignment (id, citizen_id, type, target_ref, due_at, status)
       VALUES ($1, $2, 'proposal_review', 'proposal-1', now() + interval '30 days', $3)`,
      [id, citizenId, status],
    ),
  );
}

async function insertParticipationRecord(id: string, citizenId: string, period: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO participation_record (id, citizen_id, period) VALUES ($1, $2, $3)`, [id, citizenId, period]),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, CivicDutyModule's own imports plus
// IdentityModule's) points every module's Prisma calls at the same test
// database, so this exercises the real controller -> service -> Postgres/RLS
// stack end to end instead of swapping in per-module in-memory repositories.
describe.skipIf(!urls)("CivicDutyController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [CivicDutyModule] })
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

  // Registers + activates a fresh citizen through real HTTP routes, exactly
  // like the old in-memory-repository pass's flow -- IdentityModule is
  // transitively imported by CivicDutyModule and its real service now talks
  // to the same overridden test PrismaService, so this keeps working
  // unchanged.
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

  it("GET /civic-duty/assignments without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer()).get("/civic-duty/assignments");
    expect(res.status).toBe(401);
  });

  it("GET /civic-duty/assignments returns only the calling citizen's own assignments", async () => {
    const citizenId = await activeCitizen("alice");
    const otherId = await activeCitizen("bob");
    const mineId = randomUUID();
    const theirsId = randomUUID();
    await insertAssignment(mineId, citizenId);
    await insertAssignment(theirsId, otherId);

    const res = await request(app.getHttpServer()).get("/civic-duty/assignments").set("x-citizen-id", citizenId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(mineId);
  });

  it("POST /civic-duty/assignments/:id/complete completes an own, assigned assignment", async () => {
    const citizenId = await activeCitizen("carol");
    const assignmentId = randomUUID();
    await insertAssignment(assignmentId, citizenId);

    const res = await request(app.getHttpServer())
      .post(`/civic-duty/assignments/${assignmentId}/complete`)
      .set("x-citizen-id", citizenId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("completed");
  });

  it("POST /civic-duty/assignments/:id/complete for an inactive citizen is 403", async () => {
    const registerRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "pending-dana", legalIdentifier: "id-pending-dana" });
    const citizenId = registerRes.body.id;
    const assignmentId = randomUUID();
    await insertAssignment(assignmentId, citizenId);

    const res = await request(app.getHttpServer())
      .post(`/civic-duty/assignments/${assignmentId}/complete`)
      .set("x-citizen-id", citizenId);
    expect(res.status).toBe(403);
  });

  it("POST /civic-duty/participation/exemption is 404 with no existing period record (DP-048 dependency gap)", async () => {
    const citizenId = await activeCitizen("erin");
    const res = await request(app.getHttpServer())
      .post("/civic-duty/participation/exemption")
      .set("x-citizen-id", citizenId)
      .send({ period: "2026-06", exemptionStatus: "illness" });
    expect(res.status).toBe(404);
  });

  it("POST /civic-duty/participation/exemption claims an exemption and exempts open assignments", async () => {
    const citizenId = await activeCitizen("frank");
    await insertParticipationRecord(randomUUID(), citizenId, "2026-06");
    const assignmentId = randomUUID();
    await insertAssignment(assignmentId, citizenId);

    const res = await request(app.getHttpServer())
      .post("/civic-duty/participation/exemption")
      .set("x-citizen-id", citizenId)
      .send({ period: "2026-06", exemptionStatus: "military" });
    expect(res.status).toBe(200);
    expect(res.body.exemptionStatus).toBe("military");

    const assignments = await request(app.getHttpServer())
      .get("/civic-duty/assignments")
      .set("x-citizen-id", citizenId);
    expect(assignments.body.find((a: { id: string }) => a.id === assignmentId).status).toBe("exempted");
  });
});
