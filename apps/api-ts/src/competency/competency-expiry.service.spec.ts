import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { CompetencyExpiryService } from "./competency-expiry.service.js";

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

async function insertCitizen(id: string, publicHandle: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO citizen (id, public_handle, legal_identity_hash) VALUES ($1, $2, $3)`, [
      id,
      publicHandle,
      `hash-${id}`,
    ]),
  );
}

async function insertDomain(id: string, name: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO expert_domain (id, name, description) VALUES ($1, $2, 'Scope')`, [id, name]),
  );
}

async function insertCompetency(
  id: string,
  citizenId: string,
  domainId: string,
  status: "applied" | "active" | "expired",
  expiresAt: Date | null,
): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO competency (id, citizen_id, domain_id, level, status, evidence_ref, expires_at)
       VALUES ($1, $2, $3, 2, $4, 'evidence-fixture', $5)`,
      [id, citizenId, domainId, status, expiresAt],
    ),
  );
}

function daysFromNow(offset: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

describe.skipIf(!urls)("CompetencyExpiryService (Postgres)", () => {
  let prisma: PrismaService;
  let svc: CompetencyExpiryService;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let CITIZEN: string;
  let DOMAIN: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new CompetencyExpiryService(prisma, audit);

    CITIZEN = randomUUID();
    DOMAIN = randomUUID();
    await insertCitizen(CITIZEN, "citizen-1");
    await insertDomain(DOMAIN, "domain-1");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  it("expires an active competency whose expiresAt has passed", async () => {
    const id = randomUUID();
    await insertCompetency(id, CITIZEN, DOMAIN, "active", daysFromNow(-1));

    const count = await svc.sweepExpired();

    expect(count).toBe(1);
    const row = await prisma.worker.competency.findUnique({ where: { id } });
    expect(row?.status).toBe("expired");
    expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({ actionType: "competency.expiry_swept" }));
  });

  it("leaves an active competency whose expiresAt is still in the future", async () => {
    const id = randomUUID();
    await insertCompetency(id, CITIZEN, DOMAIN, "active", daysFromNow(30));

    const count = await svc.sweepExpired();

    expect(count).toBe(0);
    const row = await prisma.worker.competency.findUnique({ where: { id } });
    expect(row?.status).toBe("active");
  });

  it("leaves a non-active competency untouched even if expiresAt has passed", async () => {
    const id = randomUUID();
    await insertCompetency(id, CITIZEN, DOMAIN, "applied", daysFromNow(-1));

    const count = await svc.sweepExpired();

    expect(count).toBe(0);
  });

  it("does not emit an audit event when nothing expires", async () => {
    await svc.sweepExpired();
    expect(audit.emit).not.toHaveBeenCalled();
  });
});
