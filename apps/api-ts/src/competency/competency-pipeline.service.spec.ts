import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { CompetencyPipelineService } from "./competency-pipeline.service.js";

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
  await withAdmin((client) => client.query(`INSERT INTO expert_domain (id, name, description) VALUES ($1, $2, $3)`, [id, name, "d"]));
}

async function insertCompetency(citizenId: string, domainId: string): Promise<string> {
  const id = randomUUID();
  await withAdmin((client) =>
    client.query(`INSERT INTO competency (id, citizen_id, domain_id, level, evidence_ref) VALUES ($1, $2, $3, 2, 'evidence')`, [
      id,
      citizenId,
      domainId,
    ]),
  );
  return id;
}

describe.skipIf(!urls)("CompetencyPipelineService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: CompetencyPipelineService;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let notification: { emit: ReturnType<typeof vi.fn> };
  let citizenId: string;
  let domainId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    notification = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new CompetencyPipelineService(prisma, audit, notification);

    citizenId = randomUUID();
    domainId = randomUUID();
    await insertCitizen(citizenId, "applicant");
    await insertDomain(domainId, "Housing");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  it("advances through every intermediate stage without granting", async () => {
    const competencyId = await insertCompetency(citizenId, domainId);

    let updated = await svc.advance(competencyId, { reviewerId: null, notes: "auto-check ok" });
    expect(updated.stage).toBe("credential_verification");
    expect(updated.status).toBe("applied");

    updated = await svc.advance(competencyId, { reviewerId: randomUUID(), notes: "public review ok" });
    expect(updated.stage).toBe("public_review");

    expect(audit.emit).not.toHaveBeenCalled();
  });

  it("grants on the final advance -- active status, grantedAt/expiresAt 3 years out, audit + notification emitted", async () => {
    const competencyId = await insertCompetency(citizenId, domainId);
    await svc.advance(competencyId, { reviewerId: null, notes: "1" }); // intake -> credential_verification
    await svc.advance(competencyId, { reviewerId: randomUUID(), notes: "2" }); // -> public_review
    await svc.advance(competencyId, { reviewerId: randomUUID(), notes: "3" }); // -> domain_peer_review
    const reviewer = randomUUID();

    const granted = await svc.advance(competencyId, { reviewerId: reviewer, notes: "peer review ok" }); // -> decided

    expect(granted.status).toBe("active");
    expect(granted.stage).toBe("decided");
    expect(granted.grantedAt).not.toBeNull();
    expect(granted.expiresAt).not.toBeNull();
    const years = granted.expiresAt!.getUTCFullYear() - granted.grantedAt!.getUTCFullYear();
    expect(years).toBe(3);
    expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({ actionType: "competency.granted" }));
    expect(notification.emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "competency.granted", citizenId }));
  });

  it("records a passed CompetencyStageReview row per advance", async () => {
    const competencyId = await insertCompetency(citizenId, domainId);
    await svc.advance(competencyId, { reviewerId: null, notes: "note-1" });

    const reviews = await svc.listReviews(competencyId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ stage: "intake", decision: "passed", notes: "note-1" });
  });

  it("reject sets status rejected, stage decided, records a failed review, notifies -- no audit emit", async () => {
    const competencyId = await insertCompetency(citizenId, domainId);
    const rejected = await svc.reject(competencyId, { reviewerId: randomUUID(), notes: "insufficient evidence" });

    expect(rejected.status).toBe("rejected");
    expect(rejected.stage).toBe("decided");
    const reviews = await svc.listReviews(competencyId);
    expect(reviews[0]).toMatchObject({ decision: "failed", notes: "insufficient evidence" });
    expect(notification.emit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "competency.rejected" }));
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it("rejects advancing a competency already at stage decided", async () => {
    const competencyId = await insertCompetency(citizenId, domainId);
    await svc.reject(competencyId, { reviewerId: null, notes: "x" });
    await expect(svc.advance(competencyId, { reviewerId: null, notes: "y" })).rejects.toBeInstanceOf(InvalidStateDomainError);
  });

  it("rejects rejecting a competency already at stage decided", async () => {
    const competencyId = await insertCompetency(citizenId, domainId);
    await svc.reject(competencyId, { reviewerId: null, notes: "x" });
    await expect(svc.reject(competencyId, { reviewerId: null, notes: "y" })).rejects.toBeInstanceOf(InvalidStateDomainError);
  });

  it("throws NotFoundDomainError for an unknown competency", async () => {
    await expect(svc.advance(randomUUID(), { reviewerId: null, notes: "x" })).rejects.toBeInstanceOf(NotFoundDomainError);
  });
});
