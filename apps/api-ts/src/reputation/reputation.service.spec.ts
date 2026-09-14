import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { ReputationService } from "./reputation.service.js";

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

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises reputation_record's RLS policies rather than just their
// SQL text, mirroring project.service.spec.ts. ReputationService now owns
// its Prisma calls directly (no repository indirection) -- these tests
// drive it through its public API only, not internal query helpers.
describe.skipIf(!urls)("ReputationService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: ReputationService;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let notification: { emit: ReturnType<typeof vi.fn> };
  let citizenId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    notification = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new ReputationService(prisma, audit, notification);

    citizenId = randomUUID();
    await insertCitizen(citizenId, "alice");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // DP-038: inserts a signed reputation_record delta row.
  describe("recordDelta (DP-038)", () => {
    it("records the delta and emits exactly one audit event", async () => {
      await svc.recordDelta({
        citizenId,
        factorType: "successful_proposal",
        delta: 3,
        reason: "Project outcome: successful",
      });

      const records = await svc.listRecords({ citizenId });
      expect(records).toHaveLength(1);
      expect(records[0].factorType).toBe("successful_proposal");
      expect(records[0].delta).toBe(3);
      expect(audit.emit).toHaveBeenCalledTimes(1);
    });

    it("emits a notification when the delta's magnitude is significant (>= 5)", async () => {
      await svc.recordDelta({ citizenId, factorType: "fraud", delta: -10, reason: "Fraud finding" });

      expect(notification.emit).toHaveBeenCalledTimes(1);
      expect(notification.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "reputation.significant_delta", citizenId }),
      );
    });

    it("does not emit a notification for a small, insignificant delta", async () => {
      await svc.recordDelta({ citizenId, factorType: "constructive", delta: 1, reason: "Helpful argument" });

      expect(notification.emit).not.toHaveBeenCalled();
    });

    it("maps a foreign-key violation on citizenId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.recordDelta({ citizenId: randomUUID(), factorType: "fraud", delta: -5, reason: "x" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // FR-027: reputation is a public informational signal, never scoped to the
  // requesting citizen's own identity.
  describe("listRecords", () => {
    it("returns every citizen's records when unfiltered, and one citizen's when filtered", async () => {
      const otherCitizenId = randomUUID();
      await insertCitizen(otherCitizenId, "bob");

      await svc.recordDelta({ citizenId, factorType: "disclosure", delta: 2, reason: "Disclosed COI" });
      await svc.recordDelta({
        citizenId: otherCitizenId,
        factorType: "misinformation",
        delta: -2,
        reason: "Flagged claim",
      });

      expect(await svc.listRecords()).toHaveLength(2);
      expect(await svc.listRecords({ citizenId: otherCitizenId })).toHaveLength(1);
    });
  });
});
