import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { DEADLOCK_STAGES, DeadlockService } from "./deadlock.service.js";

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

async function insertJurisdiction(id: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO jurisdiction (id, name, scope_level, boundary_ref) VALUES ($1, 'Muni', 'municipality', $2)`, [id, `ref-${id}`]),
  );
}

async function insertProblem(id: string, authorId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO problem (id, author_id, title, description, affected_area, jurisdiction_id) VALUES ($1, $2, 'T', 'D', 'A', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

async function insertProposal(id: string, problemId: string, authorId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO proposal (id, problem_id, author_id, title, description, support_threshold) VALUES ($1, $2, $3, 'T', 'D', 10)`,
      [id, problemId, authorId],
    ),
  );
}

async function insertAssignment(citizenId: string, targetRef: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO civic_assignment (id, citizen_id, type, target_ref, due_at) VALUES ($1, $2, 'proposal_review', $3, now() + interval '7 days')`,
      [randomUUID(), citizenId, targetRef],
    ),
  );
}

describe.skipIf(!urls)("DeadlockService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: DeadlockService;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let authorId: string;
  let reviewerId: string;
  let proposalId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    authorId = randomUUID();
    reviewerId = randomUUID();
    const jurisdictionId = randomUUID();
    const problemId = randomUUID();
    proposalId = randomUUID();
    await insertCitizen(authorId, "author");
    await insertCitizen(reviewerId, "reviewer");
    await insertJurisdiction(jurisdictionId);
    await insertProblem(problemId, authorId, jurisdictionId);
    await insertProposal(proposalId, problemId, authorId);

    const governanceRole: GovernanceRoleChecker = { isActiveHolder: vi.fn(async () => false) };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new DeadlockService(prisma, governanceRole, audit);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  describe("enter", () => {
    it("rejects a reviewer with no active proposal_review assignment", async () => {
      await expect(svc.enter(reviewerId, proposalId, "notes")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("enters the first stage and records a history entry", async () => {
      await insertAssignment(reviewerId, proposalId);
      const proposal = await svc.enter(reviewerId, proposalId, "entering deadlock");
      expect(proposal.deadlockActive).toBe(true);
      expect(proposal.deadlockStage).toBe(DEADLOCK_STAGES[0]);

      const history = await svc.history(proposalId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ stage: DEADLOCK_STAGES[0], reviewerId, notes: "entering deadlock" });
    });

    it("rejects entering twice (non-repeatable)", async () => {
      await insertAssignment(reviewerId, proposalId);
      await svc.enter(reviewerId, proposalId, "n");
      await expect(svc.enter(reviewerId, proposalId, "n")).rejects.toBeInstanceOf(InvalidStateDomainError);
    });
  });

  describe("advance", () => {
    it("rejects advancing a proposal never entered into deadlock", async () => {
      await expect(svc.advance(reviewerId, proposalId, "n")).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("requires notes", async () => {
      await insertAssignment(reviewerId, proposalId);
      await svc.enter(reviewerId, proposalId, "n");
      await expect(svc.advance(reviewerId, proposalId, "  ")).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("walks through all eight stages in order", async () => {
      await insertAssignment(reviewerId, proposalId);
      await svc.enter(reviewerId, proposalId, "stage 0");
      for (let i = 1; i < DEADLOCK_STAGES.length; i++) {
        const proposal = await svc.advance(reviewerId, proposalId, `stage ${i}`);
        expect(proposal.deadlockStage).toBe(DEADLOCK_STAGES[i]);
      }
      const history = await svc.history(proposalId);
      expect(history.map((h) => h.stage)).toEqual(DEADLOCK_STAGES);
    });

    it("rejects advancing past final_decision", async () => {
      await insertAssignment(reviewerId, proposalId);
      await svc.enter(reviewerId, proposalId, "n");
      for (let i = 1; i < DEADLOCK_STAGES.length; i++) {
        await svc.advance(reviewerId, proposalId, "n");
      }
      await expect(svc.advance(reviewerId, proposalId, "n")).rejects.toBeInstanceOf(InvalidStateDomainError);
    });
  });

  describe("conclude", () => {
    it("rejects concluding before final_decision", async () => {
      await insertAssignment(reviewerId, proposalId);
      await svc.enter(reviewerId, proposalId, "n");
      await expect(svc.conclude(reviewerId, proposalId, "approved", "n")).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("sets the proposal outcome status and deactivates the deadlock track once at final_decision", async () => {
      await insertAssignment(reviewerId, proposalId);
      await svc.enter(reviewerId, proposalId, "n");
      for (let i = 1; i < DEADLOCK_STAGES.length; i++) {
        await svc.advance(reviewerId, proposalId, "n");
      }
      const concluded = await svc.conclude(reviewerId, proposalId, "rejected", "final call");
      expect(concluded.status).toBe("rejected");
      expect(concluded.deadlockActive).toBe(false);
      expect(audit.emit).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ event: "deadlock_concluded", outcome: "rejected" }) }));
    });
  });

  it("throws NotFoundDomainError for an unknown proposal", async () => {
    await expect(svc.enter(reviewerId, randomUUID(), "n")).rejects.toBeInstanceOf(NotFoundDomainError);
  });
});
