import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { CivicDutyService } from "./civic-duty.service.js";

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
async function insertCitizen(id: string, publicHandle: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO citizen (id, public_handle, legal_identity_hash) VALUES ($1, $2, $3)`, [
      id,
      publicHandle,
      `hash-${id}`,
    ]),
  );
}

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

// Real-Postgres pass: connects as api_app (not a superuser), so this
// exercises civic_assignment/participation_record's RLS policies rather
// than just their SQL text, mirroring project.service.spec.ts.
// CivicDutyService now owns its Prisma calls directly (no repository
// indirection) -- these tests drive it through its public API only, not
// internal query helpers.
describe.skipIf(!urls)("CivicDutyService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: CivicDutyService;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let CITIZEN: string;
  let OTHER: string;
  let INACTIVE: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    CITIZEN = randomUUID();
    OTHER = randomUUID();
    INACTIVE = randomUUID();
    await insertCitizen(CITIZEN, "alice");
    await insertCitizen(OTHER, "bob");
    await insertCitizen(INACTIVE, "carol");

    const activeCitizens = new Set([CITIZEN, OTHER]);
    const citizenStatus: CitizenStatusChecker = {
      isActive: vi.fn(async (citizenId: string) => activeCitizens.has(citizenId)),
    };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new CivicDutyService(prisma, citizenStatus, audit);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  describe("completeAssignment / abandonAssignment (AUTH-010 assignment:accept/:abandon)", () => {
    it("completes an own, currently-assigned assignment and emits exactly one audit event", async () => {
      const assignmentId = randomUUID();
      await insertAssignment(assignmentId, CITIZEN);

      const updated = await svc.completeAssignment(CITIZEN, assignmentId);
      expect(updated.status).toBe("completed");
      expect(audit.emit).toHaveBeenCalledTimes(1);
    });

    it("abandons an own, currently-assigned assignment", async () => {
      const assignmentId = randomUUID();
      await insertAssignment(assignmentId, CITIZEN);

      const updated = await svc.abandonAssignment(CITIZEN, assignmentId);
      expect(updated.status).toBe("abandoned");
    });

    it("rejects completing another citizen's assignment", async () => {
      const assignmentId = randomUUID();
      await insertAssignment(assignmentId, OTHER);

      await expect(svc.completeAssignment(CITIZEN, assignmentId)).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("rejects completing an assignment that is no longer 'assigned'", async () => {
      const assignmentId = randomUUID();
      await insertAssignment(assignmentId, CITIZEN, "completed");

      await expect(svc.completeAssignment(CITIZEN, assignmentId)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("throws NotFoundDomainError for a nonexistent assignment", async () => {
      await expect(svc.completeAssignment(CITIZEN, randomUUID())).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("rejects an inactive citizen (AUTH-010 citizen.active)", async () => {
      const assignmentId = randomUUID();
      await insertAssignment(assignmentId, INACTIVE);

      await expect(svc.completeAssignment(INACTIVE, assignmentId)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  describe("claimExemption (AUTH-010 exemption:claim, FR-053)", () => {
    it("rejects claiming for a period with no existing participation_record (DP-048 dependency gap)", async () => {
      await expect(svc.claimExemption(CITIZEN, { period: "2026-06", exemptionStatus: "illness" })).rejects.toBeInstanceOf(
        NotFoundDomainError,
      );
    });

    it("sets exemptionStatus on the existing period's record and emits exactly one audit event", async () => {
      await insertParticipationRecord(randomUUID(), CITIZEN, "2026-06");

      const updated = await svc.claimExemption(CITIZEN, { period: "2026-06", exemptionStatus: "caregiving" });
      expect(updated.exemptionStatus).toBe("caregiving");
      expect(audit.emit).toHaveBeenCalledTimes(1);
    });

    it("transitions every currently-assigned assignment to 'exempted', leaving completed ones untouched", async () => {
      await insertParticipationRecord(randomUUID(), CITIZEN, "2026-06");
      const assignedId = randomUUID();
      const completedId = randomUUID();
      await insertAssignment(assignedId, CITIZEN, "assigned");
      await insertAssignment(completedId, CITIZEN, "completed");

      await svc.claimExemption(CITIZEN, { period: "2026-06", exemptionStatus: "illness" });

      const assignments = await svc.listAssignments(CITIZEN);
      const byId = new Map(assignments.map((a) => [a.id, a.status]));
      expect(byId.get(assignedId)).toBe("exempted");
      expect(byId.get(completedId)).toBe("completed");
    });
  });

  describe("listAssignments / listParticipation", () => {
    it("only ever returns the calling citizen's own rows", async () => {
      const mineId = randomUUID();
      const theirsId = randomUUID();
      await insertAssignment(mineId, CITIZEN);
      await insertAssignment(theirsId, OTHER);

      const mine = await svc.listAssignments(CITIZEN);
      expect(mine).toHaveLength(1);
      expect(mine[0].citizenId).toBe(CITIZEN);
    });
  });
});
