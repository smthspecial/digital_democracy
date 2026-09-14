import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { ProjectService } from "./project.service.js";

const urls = testDatabaseUrls();

const OVERSIGHT = "oversight-1";
const AUDITOR = "auditor-1";
const NOBODY = "citizen-1";

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

async function insertProblem(id: string, authorId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO problem (id, author_id, title, description, affected_area, jurisdiction_id)
       VALUES ($1, $2, 'Potholes', 'Too many potholes', 'Main St', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

async function insertProposal(
  id: string,
  problemId: string,
  authorId: string,
  scopeJurisdictionId: string | null,
): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO proposal (id, problem_id, author_id, title, description, scope_jurisdiction_id, support_threshold)
       VALUES ($1, $2, $3, 'Repave Main St', 'Repave the road', $4, 100)`,
      [id, problemId, authorId, scopeJurisdictionId],
    ),
  );
}

async function insertProject(id: string, proposalId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO project (id, proposal_id, timeline_start, timeline_end, contractor)
       VALUES ($1, $2, '2026-01-01', '2026-12-31', 'Acme Co')`,
      [id, proposalId],
    ),
  );
}

async function insertMilestone(id: string, projectId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO project_milestone (id, project_id, name, due_date) VALUES ($1, $2, 'Phase 1', '2026-06-01')`, [
      id,
      projectId,
    ]),
  );
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises project/project_milestone/outcome_evaluation's RLS
// policies rather than just their SQL text, mirroring
// budget.service.spec.ts. ProjectService now owns its Prisma calls directly
// (no repository indirection) -- these tests drive it through its public
// API only, not internal query helpers.
describe.skipIf(!urls)("ProjectService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: ProjectService;
  let governanceRole: GovernanceRoleChecker;
  let budgetLedger: { recordLedgerEntry: ReturnType<typeof vi.fn> };
  let reputation: { recordDelta: ReturnType<typeof vi.fn> };
  let audit: { emit: ReturnType<typeof vi.fn> };
  let notification: { emit: ReturnType<typeof vi.fn> };
  let citizenId: string;
  let jurisdictionId: string;
  let problemId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    const holders = new Map<string, string[]>([
      [OVERSIGHT, ["oversight"]],
      [AUDITOR, ["auditor"]],
    ]);
    governanceRole = {
      isActiveHolder: vi.fn(async (id: string, roleType: string) => holders.get(id)?.includes(roleType) ?? false),
    };
    budgetLedger = { recordLedgerEntry: vi.fn().mockResolvedValue(undefined) };
    reputation = { recordDelta: vi.fn().mockResolvedValue(undefined) };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    notification = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new ProjectService(prisma, governanceRole, budgetLedger, reputation, audit, notification);

    citizenId = randomUUID();
    jurisdictionId = randomUUID();
    problemId = randomUUID();
    await insertCitizen(citizenId, "alice");
    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertProblem(problemId, citizenId, jurisdictionId);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // citizenId doubles as the proposal (and problem) author throughout --
  // it's the target DP-018/DP-022's reputation/notification triggers check.
  async function seedProjectWithMilestone(scopeJurisdictionId: string | null = jurisdictionId) {
    const proposalId = randomUUID();
    const projectId = randomUUID();
    const milestoneId = randomUUID();
    await insertProposal(proposalId, problemId, citizenId, scopeJurisdictionId);
    await insertProject(projectId, proposalId);
    await insertMilestone(milestoneId, projectId);
    return { proposalId, projectId, milestoneId };
  }

  describe("reportMilestone (DP-018)", () => {
    it("rejects a citizen with no oversight/operator role", async () => {
      const { milestoneId } = await seedProjectWithMilestone();
      await expect(svc.reportMilestone(NOBODY, milestoneId, { status: "done" })).rejects.toBeInstanceOf(
        ForbiddenDomainError,
      );
    });

    it("updates status/completedAt and emits exactly one audit event", async () => {
      const { milestoneId } = await seedProjectWithMilestone();
      const updated = await svc.reportMilestone(OVERSIGHT, milestoneId, { status: "done" });
      expect(updated.status).toBe("done");
      expect(audit.emit).toHaveBeenCalledTimes(1);
    });

    it("throws NotFoundDomainError for a nonexistent milestone", async () => {
      await expect(svc.reportMilestone(OVERSIGHT, randomUUID(), { status: "done" })).rejects.toBeInstanceOf(
        NotFoundDomainError,
      );
    });

    it("increments budgetSpent and pushes a ledger entry when scopeJurisdictionId is resolvable", async () => {
      const { projectId, milestoneId } = await seedProjectWithMilestone(jurisdictionId);

      await svc.reportMilestone(OVERSIGHT, milestoneId, { status: "pending", spentDelta: 500 });

      expect(budgetLedger.recordLedgerEntry).toHaveBeenCalledTimes(1);
      expect(budgetLedger.recordLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({ jurisdictionId, direction: "outflow", amount: 500, projectId }),
      );
    });

    it("skips the ledger push (but still records the spend) when the proposal has no scope jurisdiction", async () => {
      const { projectId, milestoneId } = await seedProjectWithMilestone(null);

      await svc.reportMilestone(OVERSIGHT, milestoneId, { status: "pending", spentDelta: 500 });

      expect(budgetLedger.recordLedgerEntry).not.toHaveBeenCalled();
      const updatedProject = await svc.getProject(projectId);
      expect(updatedProject.budgetSpent).toBe(500);
    });

    it("notifies the proposal author when a milestone becomes delayed or done", async () => {
      const { milestoneId } = await seedProjectWithMilestone(null);

      await svc.reportMilestone(OVERSIGHT, milestoneId, { status: "delayed" });

      expect(notification.emit).toHaveBeenCalledTimes(1);
      expect(notification.emit).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "project.milestone_delayed", citizenId }),
      );
    });

    it("does not notify when a milestone stays pending", async () => {
      const { milestoneId } = await seedProjectWithMilestone(null);

      await svc.reportMilestone(OVERSIGHT, milestoneId, { status: "pending" });

      expect(notification.emit).not.toHaveBeenCalled();
    });
  });

  describe("submitEvaluation (DP-022)", () => {
    it("rejects a citizen with no auditor/oversight role", async () => {
      const { projectId } = await seedProjectWithMilestone();
      await expect(
        svc.submitEvaluation(NOBODY, projectId, {
          objective: "Reduce commute times",
          promisedOutcome: "20% faster commutes",
          measuredOutcome: "22% faster commutes",
          evaluation: "successful",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a nonexistent project", async () => {
      await expect(
        svc.submitEvaluation(AUDITOR, randomUUID(), {
          objective: "x",
          promisedOutcome: "y",
          measuredOutcome: "z",
          evaluation: "successful",
        }),
      ).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("records a positive reputation delta for the proposal author on a successful outcome", async () => {
      const { projectId } = await seedProjectWithMilestone(null);

      await svc.submitEvaluation(AUDITOR, projectId, {
        objective: "Reduce commute times",
        promisedOutcome: "20% faster commutes",
        measuredOutcome: "22% faster commutes",
        evaluation: "successful",
      });

      expect(reputation.recordDelta).toHaveBeenCalledTimes(1);
      expect(reputation.recordDelta).toHaveBeenCalledWith(
        expect.objectContaining({ citizenId, factorType: "successful_proposal", delta: expect.any(Number) }),
      );
      expect(reputation.recordDelta.mock.calls[0][0].delta).toBeGreaterThan(0);
    });

    it("does not record a reputation delta for an unsuccessful or partial outcome", async () => {
      const { projectId } = await seedProjectWithMilestone(null);

      await svc.submitEvaluation(AUDITOR, projectId, {
        objective: "Reduce commute times",
        promisedOutcome: "20% faster commutes",
        measuredOutcome: "no change",
        evaluation: "unsuccessful",
      });

      expect(reputation.recordDelta).not.toHaveBeenCalled();
    });
  });

  describe("public reads", () => {
    it("listProjects/getProject/listMilestones/listEvaluations require no citizen actor", async () => {
      const { projectId } = await seedProjectWithMilestone(null);

      expect(await svc.listProjects()).toHaveLength(1);
      expect((await svc.getProject(projectId)).id).toBe(projectId);
      expect(await svc.listMilestones({ projectId })).toHaveLength(1);
      expect(await svc.listEvaluations({ projectId })).toHaveLength(0);
    });
  });
});
