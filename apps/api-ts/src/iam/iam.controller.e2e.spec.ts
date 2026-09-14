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
import { IamModule } from "./iam.module.js";

const urls = testDatabaseUrls();

const PROPOSER = randomUUID();
const ENDORSER = randomUUID();
const NOBODY = randomUUID();

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

// Postgres-backed HTTP pass: a single PrismaService override (the whole
// graph shares that one @Global token, IamModule's own imports plus
// GovernanceRoleModule's) points every module's Prisma calls at the same
// test database, so this exercises the real controller -> service ->
// Postgres/RLS stack end to end instead of swapping in per-module in-memory
// repositories. governance_role rows are seeded directly (raw SQL) rather
// than through an InMemoryGovernanceRoleRepository, since GovernanceRoleService
// now reads real Postgres too.
describe.skipIf(!urls)("IamController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    await insertCitizen(PROPOSER, "proposer");
    await insertCitizen(ENDORSER, "endorser");
    await insertCitizen(NOBODY, "nobody");
    await insertGovernanceRole(randomUUID(), PROPOSER, "operator");
    await insertGovernanceRole(randomUUID(), ENDORSER, "operator");

    const moduleRef = await Test.createTestingModule({ imports: [IamModule] })
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

  const POLICY_BODY = {
    name: "Allow secret rotation",
    effect: "allow",
    actions: ["secrets:rotate"],
    resources: ["*"],
    description: "Lets platform-operators rotate secrets",
  };

  it("POST /iam/policies without an operator/platform_operator role is 403", async () => {
    const res = await request(app.getHttpServer()).post("/iam/policies").set("x-citizen-id", NOBODY).send(POLICY_BODY);
    expect(res.status).toBe(403);
  });

  it("POST /iam/policies without x-citizen-id is 401", async () => {
    const res = await request(app.getHttpServer()).post("/iam/policies").send(POLICY_BODY);
    expect(res.status).toBe(401);
  });

  it("full grant flow: propose -> endorse activates -> evaluate allows -> revoke -> evaluate denies", async () => {
    const proposeRes = await request(app.getHttpServer())
      .post("/iam/policies")
      .set("x-citizen-id", PROPOSER)
      .send(POLICY_BODY);
    expect(proposeRes.status).toBe(201);
    expect(proposeRes.body.status).toBe("pending_approval");
    const policyId = proposeRes.body.id;

    const attachRes = await request(app.getHttpServer())
      .post("/iam/attachments")
      .set("x-citizen-id", PROPOSER)
      .send({ policyId, principalRef: `citizen:${PROPOSER}` });
    expect(attachRes.status).toBe(201);
    const attachmentId = attachRes.body.id;

    await request(app.getHttpServer())
      .post(`/iam/policies/${policyId}/endorsements`)
      .set("x-citizen-id", ENDORSER)
      .send({ decision: "approved" })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/iam/attachments/${attachmentId}/endorsements`)
      .set("x-citizen-id", ENDORSER)
      .send({ decision: "approved" })
      .expect(201);

    const allowed = await request(app.getHttpServer())
      .post("/iam/evaluate")
      .send({ principalRef: `citizen:${PROPOSER}`, action: "secrets:rotate", resource: "cluster-1" });
    expect(allowed.status).toBe(201);
    expect(allowed.body.effect).toBe("allow");

    await request(app.getHttpServer()).post(`/iam/policies/${policyId}/revoke`).set("x-citizen-id", ENDORSER).expect(201);

    const denied = await request(app.getHttpServer())
      .post("/iam/evaluate")
      .send({ principalRef: `citizen:${PROPOSER}`, action: "secrets:rotate", resource: "cluster-1" });
    expect(denied.body.effect).toBe("deny");
  });

  it("GET /iam/policies is public and lists proposed policies", async () => {
    const res = await request(app.getHttpServer()).get("/iam/policies");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
