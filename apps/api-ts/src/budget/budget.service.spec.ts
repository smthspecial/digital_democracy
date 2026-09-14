import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictDomainError, ForbiddenDomainError, InvalidStateDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { BudgetService } from "./budget.service.js";

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

async function insertJurisdiction(id: string, name: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction (id, name, scope_level, boundary_ref) VALUES ($1, $2, 'municipality', $3)`, [
      id,
      name,
      `ref-${id}`,
    ]),
  );
}

// No citizen-facing (or worker-facing) create op exists for budget_category
// in this pass (DP-051's aggregation cron, out of scope) -- fixtures go in
// directly via the admin connection, the same way jurisdiction.repository.prisma.spec.ts
// seeds rows no repository method here can create.
async function insertCategory(id: string, jurisdictionId: string, name: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO budget_category (id, jurisdiction_id, name) VALUES ($1, $2, $3)`, [
      id,
      jurisdictionId,
      name,
    ]),
  );
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises ARCH-023's RLS policies rather than just their SQL text
// (ADR-030), mirroring project.service.spec.ts. BudgetService now owns its
// Prisma calls directly (no repository indirection) -- these tests drive it
// through its public API only, not internal query helpers.
describe.skipIf(!urls)("BudgetService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: BudgetService;
  let citizenStatus: CitizenStatusChecker;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let activeCitizens: Set<string>;
  let jurisdictionId: string;
  let categoryId: string;
  let citizenId: string;
  let otherCitizenId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    citizenId = randomUUID();
    otherCitizenId = randomUUID();
    activeCitizens = new Set([citizenId, otherCitizenId]);
    citizenStatus = {
      isActive: vi.fn(async (id: string) => activeCitizens.has(id)),
    };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new BudgetService(prisma, citizenStatus, audit);

    jurisdictionId = randomUUID();
    categoryId = randomUUID();
    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertCategory(categoryId, jurisdictionId, "Healthcare");
    await insertCitizen(citizenId, "alice");
    await insertCitizen(otherCitizenId, "bob");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // DP-013: AUTH-010 budget:vote -- scope any, conditions citizen.active +
  // totals:100.
  describe("submitAllocation (DP-013, AUTH-010 budget:vote)", () => {
    it("rejects an inactive citizen", async () => {
      activeCitizens.delete(citizenId);
      await expect(
        svc.submitAllocation(citizenId, { period: "2026-Q3", allocations: [{ categoryId, percentage: 100 }] }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects allocations summing to more than 100", async () => {
      const secondCategoryId = randomUUID();
      await insertCategory(secondCategoryId, jurisdictionId, "Education");
      await expect(
        svc.submitAllocation(citizenId, {
          period: "2026-Q3",
          allocations: [
            { categoryId, percentage: 60 },
            { categoryId: secondCategoryId, percentage: 60 },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("rejects allocations summing to less than 100", async () => {
      await expect(
        svc.submitAllocation(citizenId, { period: "2026-Q3", allocations: [{ categoryId, percentage: 40 }] }),
      ).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("accepts allocations summing to 100 within floating-point tolerance (33.33/33.33/33.34)", async () => {
      const secondCategoryId = randomUUID();
      const thirdCategoryId = randomUUID();
      await insertCategory(secondCategoryId, jurisdictionId, "Education");
      await insertCategory(thirdCategoryId, jurisdictionId, "Transit");

      const votes = await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [
          { categoryId, percentage: 33.33 },
          { categoryId: secondCategoryId, percentage: 33.33 },
          { categoryId: thirdCategoryId, percentage: 33.34 },
        ],
      });
      expect(votes).toHaveLength(3);
      expect(votes.every((v) => v.citizenId === citizenId && v.period === "2026-Q3")).toBe(true);
    });

    it("resubmitting for the same period replaces the prior set (old categories are gone)", async () => {
      const secondCategoryId = randomUUID();
      const thirdCategoryId = randomUUID();
      await insertCategory(secondCategoryId, jurisdictionId, "Education");
      await insertCategory(thirdCategoryId, jurisdictionId, "Transit");

      await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [
          { categoryId, percentage: 60 },
          { categoryId: secondCategoryId, percentage: 40 },
        ],
      });

      await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [{ categoryId: thirdCategoryId, percentage: 100 }],
      });

      const current = await svc.getMyAllocation(citizenId, "2026-Q3");
      expect(current).toHaveLength(1);
      expect(current[0].categoryId).toBe(thirdCategoryId);
    });

    it("an empty allocations array clears the period's allocation (delete-only, no totals check)", async () => {
      await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [{ categoryId, percentage: 100 }],
      });

      const cleared = await svc.submitAllocation(citizenId, { period: "2026-Q3", allocations: [] });
      expect(cleared).toHaveLength(0);
      expect(await svc.getMyAllocation(citizenId, "2026-Q3")).toHaveLength(0);
    });

    it("does not disturb a different period's allocation for the same citizen", async () => {
      const secondCategoryId = randomUUID();
      await insertCategory(secondCategoryId, jurisdictionId, "Education");

      await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [{ categoryId, percentage: 100 }],
      });
      await svc.submitAllocation(citizenId, {
        period: "2026-Q4",
        allocations: [{ categoryId: secondCategoryId, percentage: 100 }],
      });

      expect(await svc.getMyAllocation(citizenId, "2026-Q3")).toHaveLength(1);
      expect(await svc.getMyAllocation(citizenId, "2026-Q4")).toHaveLength(1);
    });

    it("maps a foreign-key violation on categoryId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.submitAllocation(citizenId, {
          period: "2026-Q3",
          allocations: [{ categoryId: randomUUID(), percentage: 100 }],
        }),
      ).rejects.toThrow(/not found/i);
    });

    // A duplicate categoryId within one submission collides with
    // budget_allocation_vote's @@unique([citizenId, categoryId, period]) on
    // the second insert (the first succeeds) -- must map to
    // ConflictDomainError (P2002), never escape as a raw
    // PrismaClientKnownRequestError / unhandled 500.
    it("maps a unique-constraint violation on a duplicate categoryId within one submission to ConflictDomainError (P2002)", async () => {
      await expect(
        svc.submitAllocation(citizenId, {
          period: "2026-Q3",
          allocations: [
            { categoryId, percentage: 50 },
            { categoryId, percentage: 50 },
          ],
        }),
      ).rejects.toBeInstanceOf(ConflictDomainError);

      // And it must not have left a partial row behind from the first insert.
      expect(await svc.getMyAllocation(citizenId, "2026-Q3")).toHaveLength(0);
    });
  });

  describe("getMyAllocation", () => {
    it("returns only the calling citizen's own rows for the period, never another citizen's", async () => {
      const secondCategoryId = randomUUID();
      await insertCategory(secondCategoryId, jurisdictionId, "Education");

      await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [{ categoryId, percentage: 100 }],
      });
      await svc.submitAllocation(otherCitizenId, {
        period: "2026-Q3",
        allocations: [{ categoryId: secondCategoryId, percentage: 100 }],
      });

      const mine = await svc.getMyAllocation(citizenId, "2026-Q3");
      expect(mine).toHaveLength(1);
      expect(mine[0].citizenId).toBe(citizenId);
    });

    it("under a different citizen's RLS context cannot read another citizen's rows (no public-read policy)", async () => {
      await svc.submitAllocation(citizenId, {
        period: "2026-Q3",
        allocations: [{ categoryId, percentage: 100 }],
      });

      const otherView = await svc.getMyAllocation(otherCitizenId, "2026-Q3");
      expect(otherView).toHaveLength(0);

      const ownView = await svc.getMyAllocation(citizenId, "2026-Q3");
      expect(ownView).toHaveLength(1);
    });
  });

  // DP-019: AUTH-006 ledger_entry:record is an operator permission, enforced
  // by iam-service (not built) -- exercised only directly on the service,
  // with no citizen actor and no HTTP route (see budget.module.ts).
  describe("recordLedgerEntry (DP-019)", () => {
    it("succeeds via the worker connection (api_worker-only INSERT) and emits exactly one audit event, callable with no citizen context", async () => {
      const entry = await svc.recordLedgerEntry({
        jurisdictionId,
        categoryId,
        direction: "inflow",
        amount: 1000,
        source: "tax revenue",
        occurredAt: new Date("2026-01-01"),
      });

      expect(entry.direction).toBe("inflow");
      expect(entry.amount).toBe(1000);
      expect(entry.jurisdictionId).toBe(jurisdictionId);
      expect(entry.categoryId).toBe(categoryId);
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          actionType: expect.stringContaining("ledger"),
          payload: expect.objectContaining({ ledgerEntryId: entry.id }),
        }),
      );
    });

    it("maps a foreign-key violation on jurisdictionId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.recordLedgerEntry({
          jurisdictionId: randomUUID(),
          direction: "inflow",
          amount: 1,
          source: "x",
          occurredAt: new Date(),
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("maps a foreign-key violation on categoryId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.recordLedgerEntry({
          jurisdictionId,
          categoryId: randomUUID(),
          direction: "inflow",
          amount: 1,
          source: "x",
          occurredAt: new Date(),
        }),
      ).rejects.toThrow(/not found/i);
    });

    it("accepts a null categoryId and an unchecked projectId (no Project table/FK exists)", async () => {
      const projectId = randomUUID();
      const entry = await svc.recordLedgerEntry({
        jurisdictionId,
        projectId,
        direction: "outflow",
        amount: 10,
        source: "vendor",
        occurredAt: new Date(),
      });
      expect(entry.categoryId).toBeNull();
      expect(entry.projectId).toBe(projectId);
    });
  });

  describe("listCategories / listLedgerEntries", () => {
    it("listCategories is public read (no citizen context), optionally filtered by jurisdictionId", async () => {
      const otherJurisdictionId = randomUUID();
      const otherCategoryId = randomUUID();
      await insertJurisdiction(otherJurisdictionId, "Other");
      await insertCategory(otherCategoryId, otherJurisdictionId, "Education");

      const all = await svc.listCategories();
      expect(all.map((c) => c.id).sort()).toEqual([categoryId, otherCategoryId].sort());

      const filtered = await svc.listCategories({ jurisdictionId });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe(categoryId);
      expect(filtered[0].allocatedAmount).toBeNull();
    });

    it("listLedgerEntries is public read, optionally filtered by jurisdictionId", async () => {
      await svc.recordLedgerEntry({
        jurisdictionId,
        categoryId,
        direction: "inflow",
        amount: 100,
        source: "a",
        occurredAt: new Date(),
      });
      const otherJurisdictionId = randomUUID();
      await insertJurisdiction(otherJurisdictionId, "Other");
      await svc.recordLedgerEntry({
        jurisdictionId: otherJurisdictionId,
        direction: "outflow",
        amount: 5,
        source: "b",
        occurredAt: new Date(),
      });

      const all = await svc.listLedgerEntries();
      expect(all).toHaveLength(2);

      const filtered = await svc.listLedgerEntries({ jurisdictionId });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].jurisdictionId).toBe(jurisdictionId);
    });
  });
});
