import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { DuplicateDetectionService, levenshtein, normalize } from "./duplicate-detection.service.js";

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

async function insertCitizen(id: string, publicHandle: string, status = "active", createdAt?: Date): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO citizen (id, public_handle, legal_identity_hash, status, created_at) VALUES ($1, $2, $3, $4, COALESCE($5, now()))`,
      [id, publicHandle, `hash-${id}`, status, createdAt ?? null],
    ),
  );
}

describe("levenshtein (pure)", () => {
  it("is 0 for identical strings", () => {
    expect(levenshtein("alice", "alice")).toBe(0);
  });
  it("counts a single substitution", () => {
    expect(levenshtein("alice", "alicx")).toBe(1);
  });
  it("counts insertions/deletions", () => {
    expect(levenshtein("alice", "alicee")).toBe(1);
  });
});

describe("normalize (pure)", () => {
  it("lowercases and trims", () => {
    expect(normalize("  Alice  ")).toBe("alice");
  });
});

describe.skipIf(!urls)("DuplicateDetectionService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: DuplicateDetectionService;
  let audit: { emit: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new DuplicateDetectionService(prisma, audit);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  describe("scanForDuplicateSignals", () => {
    it("flags two citizens whose handles normalize within distance 2", async () => {
      await insertCitizen(randomUUID(), "Alice");
      await insertCitizen(randomUUID(), " alice ");
      const signals = await svc.scanForDuplicateSignals();
      expect(signals).toHaveLength(1);
      expect(signals[0].distance).toBe(0);
    });

    it("does not flag dissimilar handles", async () => {
      await insertCitizen(randomUUID(), "Alice");
      await insertCitizen(randomUUID(), "Bob");
      expect(await svc.scanForDuplicateSignals()).toHaveLength(0);
    });

    it("excludes revoked citizens from the scan", async () => {
      await insertCitizen(randomUUID(), "Alice", "revoked");
      await insertCitizen(randomUUID(), "alice", "active");
      expect(await svc.scanForDuplicateSignals()).toHaveLength(0);
    });

    it("emits exactly one aggregate audit event per scan that finds signals (EC-49, FR-001/FR-060)", async () => {
      await insertCitizen(randomUUID(), "Alice");
      await insertCitizen(randomUUID(), "alice");
      await insertCitizen(randomUUID(), "alicee");
      await svc.scanForDuplicateSignals();
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "identity.duplicate_signals_flagged" }),
      );
    });

    it("emits no audit event when a scan finds nothing", async () => {
      await insertCitizen(randomUUID(), "Alice");
      await insertCitizen(randomUUID(), "Bob");
      await svc.scanForDuplicateSignals();
      expect(audit.emit).not.toHaveBeenCalled();
    });
  });

  describe("detectRegistrationBurst", () => {
    it("is not anomalous under the threshold", async () => {
      await insertCitizen(randomUUID(), "a1");
      const result = await svc.detectRegistrationBurst();
      expect(result.anomalous).toBe(false);
      expect(result.count).toBe(1);
    });

    it("is anomalous over 20 registrations within the trailing hour", async () => {
      for (let i = 0; i < 21; i++) {
        await insertCitizen(randomUUID(), `burst-${i}`);
      }
      const result = await svc.detectRegistrationBurst();
      expect(result.anomalous).toBe(true);
      expect(result.count).toBe(21);
    });

    it("ignores registrations outside the trailing hour", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (let i = 0; i < 25; i++) {
        await insertCitizen(randomUUID(), `old-${i}`, "active", twoHoursAgo);
      }
      const result = await svc.detectRegistrationBurst();
      expect(result.anomalous).toBe(false);
      expect(result.count).toBe(0);
    });
  });
});
