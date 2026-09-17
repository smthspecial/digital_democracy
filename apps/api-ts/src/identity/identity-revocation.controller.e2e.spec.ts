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
import { IdentityRevocationModule } from "./identity-revocation.module.js";

process.env.IDENTITY_HASH_SECRET ??= "test-secret";

const urls = testDatabaseUrls();

function daysFromToday(offset: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

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

async function insertGovernanceRole(citizenId: string, layer: string, roleType = "auditor"): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO governance_role (id, citizen_id, role_type, layer, term_start, term_end, randomized)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), citizenId, roleType, layer, isoDate(daysFromToday(-30)), isoDate(daysFromToday(30)), false],
    ),
  );
}

describe.skipIf(!urls)("IdentityRevocationController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({ imports: [IdentityRevocationModule] })
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

  async function fullyApprove(actionRef: string): Promise<void> {
    const auditApprover = await activeCitizen(`auditor-${randomUUID()}`);
    await insertGovernanceRole(auditApprover, "audit");
    await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", auditApprover)
      .send({ actionRef, approvalType: "audit_confirmation", decision: "approved" });

    const bodyApprover = await activeCitizen(`body-${randomUUID()}`);
    await insertGovernanceRole(bodyApprover, "protocol", "review_body");
    await request(app.getHttpServer())
      .post("/governance-role/approvals")
      .set("x-citizen-id", bodyApprover)
      .send({ actionRef, approvalType: "body_endorsement", decision: "approved" });
  }

  it("POST /identity/revocations rejects a non-operator actor (EC-27/EC-43, FR-006/FR-007)", async () => {
    const actorId = await activeCitizen("nonop");
    const targetId = await activeCitizen("target1");

    const res = await request(app.getHttpServer())
      .post("/identity/revocations")
      .set("x-citizen-id", actorId)
      .send({ citizenId: targetId, reason: "proven_fraud", justification: "j" });

    expect(res.status).toBe(403);
  });

  it("POST /identity/revocations rejects an unknown citizen (EC-18, FR-006)", async () => {
    const actorId = await activeCitizen("operator1");
    await insertGovernanceRole(actorId, "implementation", "operator");

    const res = await request(app.getHttpServer())
      .post("/identity/revocations")
      .set("x-citizen-id", actorId)
      .send({ citizenId: randomUUID(), reason: "death", justification: "j" });

    expect(res.status).toBe(404);
  });

  it("POST /identity/revocations/:actionRef/execute fails closed before the 2-of-2 gate is satisfied (EC-27/EC-43, FR-006/FR-007)", async () => {
    const actorId = await activeCitizen("operator2");
    await insertGovernanceRole(actorId, "implementation", "operator");
    const targetId = await activeCitizen("target2");

    const requestRes = await request(app.getHttpServer())
      .post("/identity/revocations")
      .set("x-citizen-id", actorId)
      .send({ citizenId: targetId, reason: "death", justification: "j" });
    expect(requestRes.status).toBe(201);

    const execRes = await request(app.getHttpServer()).post(`/identity/revocations/${requestRes.body.actionRef}/execute`);
    expect(execRes.status).toBe(422);

    const statusRes = await request(app.getHttpServer())
      .get(`/identity/citizens/${targetId}/status`);
    expect(statusRes.body.status).toBe("active");
  });

  it("POST /identity/revocations/:actionRef/execute revokes the citizen once fully approved, and a revoked legal identifier can re-register (EC-19, FR-001/FR-006)", async () => {
    const actorId = await activeCitizen("operator3");
    await insertGovernanceRole(actorId, "implementation", "operator");
    const targetHandle = "target3";
    const targetId = await activeCitizen(targetHandle);

    const requestRes = await request(app.getHttpServer())
      .post("/identity/revocations")
      .set("x-citizen-id", actorId)
      .send({ citizenId: targetId, reason: "death", justification: "j" });

    await fullyApprove(requestRes.body.actionRef);

    const execRes = await request(app.getHttpServer()).post(`/identity/revocations/${requestRes.body.actionRef}/execute`);
    expect(execRes.status).toBe(201);
    expect(execRes.body.status).toBe("revoked");

    const reRegisterRes = await request(app.getHttpServer())
      .post("/identity/citizens")
      .send({ publicHandle: "target3-again", legalIdentifier: `id-${targetHandle}` });
    expect(reRegisterRes.status).toBe(201);
  });
});
