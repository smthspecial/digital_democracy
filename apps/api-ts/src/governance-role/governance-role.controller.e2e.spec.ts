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
import { GovernanceRoleModule } from "./governance-role.module.js";

process.env.IDENTITY_HASH_SECRET ??= "test-secret";

const urls = testDatabaseUrls();

function daysFromToday(offset: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

// term_start/term_end are DATE columns -- send date-only text so Postgres
// doesn't have to reinterpret a full timestamp.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls!.admin });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function insertGovernanceRole(
  id: string,
  citizenId: string,
  opts: { roleType?: string; layer?: string; termStart?: Date; termEnd?: Date; randomized?: boolean } = {},
): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO governance_role (id, citizen_id, role_type, layer, term_start, term_end, randomized)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        citizenId,
        opts.roleType ?? "auditor",
        opts.layer ?? "audit",
        isoDate(opts.termStart ?? daysFromToday(-30)),
        isoDate(opts.termEnd ?? daysFromToday(30)),
        opts.randomized ?? false,
      ],
    ),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, GovernanceRoleModule's own imports
// plus IdentityModule's, transitively imported for CITIZEN_STATUS_CHECKER)
// points every module's Prisma calls at the same test database, so this
// exercises the real controller -> service -> Postgres/RLS stack end to end
// instead of swapping in per-module in-memory repositories.
describe.skipIf(!urls)("GovernanceRoleController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [GovernanceRoleModule] })
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

  it("GET /governance-role/roles lists roles, optionally filtered by citizenId (public)", async () => {
    const citizenId = await activeCitizen("alice");
    await insertGovernanceRole(randomUUID(), citizenId);

    const res = await request(app.getHttpServer()).get("/governance-role/roles").query({ citizenId });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].citizenId).toBe(citizenId);
  });

  it("POST /governance-role/approvals submits an approval for a live-term role holder (DP-023)", async () => {
    const citizenId = await activeCitizen("bob");
    await insertGovernanceRole(randomUUID(), citizenId);

    const res = await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", citizenId)
      .send({ actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });

    expect(res.status).toBe(201);
    expect(res.body.actionRef).toBe("action-1");
    expect(res.body.decision).toBe("approved");
  });

  it("POST /governance-role/approvals rejects citizen_supermajority as an invalid body (FR-061)", async () => {
    const citizenId = await activeCitizen("carol");
    await insertGovernanceRole(randomUUID(), citizenId);

    const res = await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", citizenId)
      .send({ actionRef: "action-1", approvalType: "citizen_supermajority", decision: "approved" });

    expect(res.status).toBe(400);
  });

  it("POST /governance-role/approvals without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .send({ actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });
    expect(res.status).toBe(401);
  });

  it("POST /governance-role/approvals is 403 for a citizen with no active governance_role", async () => {
    const citizenId = await activeCitizen("dana");

    const res = await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", citizenId)
      .send({ actionRef: "action-1", approvalType: "audit_confirmation", decision: "approved" });

    expect(res.status).toBe(403);
  });

  it("POST /governance-role/approvals is 409 on a second submission by the same citizen for the same actionRef", async () => {
    const citizenId = await activeCitizen("erin");
    await insertGovernanceRole(randomUUID(), citizenId);

    await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", citizenId)
      .send({ actionRef: "action-2", approvalType: "audit_confirmation", decision: "approved" });

    const res = await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", citizenId)
      .send({ actionRef: "action-2", approvalType: "body_endorsement", decision: "rejected" });

    expect(res.status).toBe(409);
  });

  it("GET /governance-role/approvals lists approvals, optionally filtered by actionRef (public)", async () => {
    const citizenId = await activeCitizen("frank");
    await insertGovernanceRole(randomUUID(), citizenId);

    await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", citizenId)
      .send({ actionRef: "action-3", approvalType: "audit_confirmation", decision: "approved" });

    const res = await request(app.getHttpServer()).get("/governance-role/approvals").query({ actionRef: "action-3" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].actionRef).toBe("action-3");
  });
});
