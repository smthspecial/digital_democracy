import { randomUUID } from "node:crypto";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { JurisdictionModule } from "./jurisdiction.module.js";

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

async function insertJurisdiction(row: {
  id: string;
  parentId?: string | null;
  name: string;
  scopeLevel: string;
  boundaryRef: string;
}): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction (id, parent_id, name, scope_level, boundary_ref) VALUES ($1, $2, $3, $4, $5)`, [
      row.id,
      row.parentId ?? null,
      row.name,
      row.scopeLevel,
      row.boundaryRef,
    ]),
  );
}

// Postgres-backed HTTP pass: a single PrismaService override points the
// module's Prisma calls at the test database, so this exercises the real
// controller -> service -> Postgres/RLS stack end to end instead of
// swapping in an in-memory repository.
describe.skipIf(!urls)("JurisdictionController (HTTP, Postgres-backed)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let nationalId: string;
  let regionalId: string;
  let municipalityId: string;

  beforeAll(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    nationalId = randomUUID();
    regionalId = randomUUID();
    municipalityId = randomUUID();

    await insertJurisdiction({ id: nationalId, name: "Nation", scopeLevel: "national", boundaryRef: `ref-${nationalId}` });
    await insertJurisdiction({
      id: regionalId,
      parentId: nationalId,
      name: "Region",
      scopeLevel: "regional",
      boundaryRef: `ref-${regionalId}`,
    });
    await insertJurisdiction({
      id: municipalityId,
      parentId: regionalId,
      name: "Municipality",
      scopeLevel: "municipality",
      boundaryRef: `ref-${municipalityId}`,
    });

    const moduleRef = await Test.createTestingModule({ imports: [JurisdictionModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await prisma?.onModuleDestroy();
  });

  it("GET /jurisdiction/jurisdictions returns 200 with the correctly nested tree", async () => {
    const res = await request(app.getHttpServer()).get("/jurisdiction/jurisdictions");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(nationalId);
    expect(res.body[0].children).toHaveLength(1);
    expect(res.body[0].children[0].id).toBe(regionalId);
    expect(res.body[0].children[0].children).toHaveLength(1);
    expect(res.body[0].children[0].children[0].id).toBe(municipalityId);
  });

  it("is publicly reachable without an x-citizen-id header (public SELECT policy)", async () => {
    const res = await request(app.getHttpServer()).get("/jurisdiction/jurisdictions");
    expect(res.status).toBe(200);
  });
});
