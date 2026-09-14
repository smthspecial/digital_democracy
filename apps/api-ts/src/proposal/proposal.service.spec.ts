import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import type { JurisdictionMembershipChecker } from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { ProposalService } from "./proposal.service.js";
import { ProposalStatus } from "./proposal.types.js";

const urls = testDatabaseUrls();

const OTHER = randomUUID();

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
       VALUES ($1, $2, 'Problem', 'Description', 'Area', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

async function insertProblemSupport(problemId: string, citizenId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO problem_support (id, problem_id, citizen_id) VALUES ($1, $2, $3)`, [
      randomUUID(),
      problemId,
      citizenId,
    ]),
  );
}

// Direct row insert (bypassing ProposalService.create, which only ever
// produces a fresh draft proposal with no scope jurisdiction) so tests can
// exercise every status/scope combination -- mirrors seedProposal's role in
// the old InMemoryProposalRepository-backed spec.
async function insertProposal(input: {
  id?: string;
  problemId: string;
  authorId: string;
  status?: ProposalStatus;
  scopeJurisdictionId?: string | null;
  supportThreshold?: number;
}): Promise<string> {
  const id = input.id ?? randomUUID();
  await withAdmin((client) =>
    client.query(
      `INSERT INTO proposal (id, problem_id, author_id, title, description, scope_jurisdiction_id, support_threshold, status)
       VALUES ($1, $2, $3, 'Title', 'Description', $4, $5, $6)`,
      [id, input.problemId, input.authorId, input.scopeJurisdictionId ?? null, input.supportThreshold ?? 10, input.status ?? "draft"],
    ),
  );
  return id;
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises proposal/proposal_constraint/proposal_budget's RLS policies
// rather than just their SQL text, mirroring project.service.spec.ts.
// ProposalService now owns its Prisma calls directly (no repository
// indirection) -- these tests drive it through its public API only, not
// internal query helpers. citizenStatus/jurisdictionMembership stay fakes,
// exactly as the old InMemoryProposalRepository-backed spec used them --
// only the proposal/problem/problem_support persistence this module itself
// owns moves onto real Postgres.
describe.skipIf(!urls)("ProposalService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let citizenId: string;
  let jurisdictionId: string;
  let problemId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    citizenId = randomUUID();
    jurisdictionId = randomUUID();
    problemId = randomUUID();
    await insertCitizen(citizenId, "author");
    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertProblem(problemId, citizenId, jurisdictionId);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  function service(opts?: { active?: string[]; affected?: Array<[string, string]> }) {
    const activeCitizens = new Set(opts?.active ?? [citizenId, OTHER]);
    const affectedPairs = new Set((opts?.affected ?? []).map(([cid, jid]) => `${cid}:${jid}`));

    const citizenStatus: CitizenStatusChecker = {
      isActive: vi.fn(async (id: string) => activeCitizens.has(id)),
    };
    const jurisdictionMembership: JurisdictionMembershipChecker = {
      isMember: vi.fn(async () => false),
      isAffected: vi.fn(async (cid: string, jid: string) => affectedPairs.has(`${cid}:${jid}`)),
    };
    const audit = { emit: vi.fn().mockResolvedValue(undefined) };

    const svc = new ProposalService(prisma, citizenStatus, jurisdictionMembership, audit);
    return { svc, citizenStatus, jurisdictionMembership, audit, activeCitizens };
  }

  // DP-005: proposal:create -- scope any, condition citizen.active.
  describe("create (DP-005, AUTH-010 proposal:create)", () => {
    it("creates a draft proposal authored by the calling citizen", async () => {
      const { svc } = service();
      const proposal = await svc.create(citizenId, {
        problemId,
        title: "Fix the pothole",
        description: "Repave the street",
        supportThreshold: 25,
      });
      expect(proposal.status).toBe("draft");
      expect(proposal.authorId).toBe(citizenId);
      expect(proposal.supportCount).toBe(0);
      expect(proposal.supportThreshold).toBe(25);
    });

    it("emits DP-036 on creation", async () => {
      const { svc, audit } = service();
      const proposal = await svc.create(citizenId, {
        problemId,
        title: "T",
        description: "D",
        supportThreshold: 1,
      });
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: expect.stringContaining("proposal"), actorRef: citizenId }),
      );
      expect(audit.emit.mock.calls[0][0].payload).toMatchObject({ proposalId: proposal.id });
    });

    it("rejects an inactive citizen", async () => {
      const { svc } = service({ active: [] });
      await expect(
        svc.create(citizenId, { problemId, title: "T", description: "D", supportThreshold: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    // Ported from the deleted proposal.repository.prisma.spec.ts -- the old
    // InMemoryProposalRepository never modeled a problem table, so this
    // foreign-key mapping (problem_id -> NotFoundDomainError) had no
    // in-memory equivalent; reachable through create()'s public API, so
    // kept (mirrors ProjectService's own ported NotFoundDomainError cases).
    it("throws NotFoundDomainError when problemId does not reference an existing problem (P2003)", async () => {
      const { svc } = service();
      await expect(
        svc.create(citizenId, { problemId: randomUUID(), title: "T", description: "D", supportThreshold: 1 }),
      ).rejects.toBeInstanceOf(NotFoundDomainError);
    });
  });

  // DP-006: proposal:constraint:add -- scope proposal:author, conditions
  // citizen.active + proposal.status:draft,gathering_support,development.
  describe("addConstraint (DP-006, AUTH-010 proposal:constraint:add)", () => {
    it("rejects an inactive citizen", async () => {
      const { svc } = service({ active: [OTHER] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.addConstraint(citizenId, proposalId, { text: "must not raise taxes" })).rejects.toBeInstanceOf(
        ForbiddenDomainError,
      );
    });

    it("throws NotFoundDomainError for a missing proposal", async () => {
      const { svc } = service();
      await expect(svc.addConstraint(citizenId, randomUUID(), { text: "x" })).rejects.toBeInstanceOf(
        NotFoundDomainError,
      );
    });

    it("forbids a non-author from adding a constraint", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.addConstraint(OTHER, proposalId, { text: "x" })).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it.each(["draft", "gathering_support", "development"] as const)(
      "allows the author to add a constraint while status is %s",
      async (status) => {
        const { svc } = service();
        const proposalId = await insertProposal({ problemId, authorId: citizenId, status });
        const constraint = await svc.addConstraint(citizenId, proposalId, { text: "no new taxes" });
        expect(constraint.proposalId).toBe(proposalId);
        expect(constraint.text).toBe("no new taxes");
        expect(constraint.agreed).toBe(false);
      },
    );

    it.each(["voting", "approved", "rejected", "archived"] as const)(
      "rejects adding a constraint while status is %s",
      async (status) => {
        const { svc } = service();
        const proposalId = await insertProposal({ problemId, authorId: citizenId, status });
        await expect(svc.addConstraint(citizenId, proposalId, { text: "x" })).rejects.toBeInstanceOf(
          InvalidStateDomainError,
        );
      },
    );
  });

  // DP-007: proposal:budget:add -- scope proposal:author, condition
  // citizen.active only (AUTH-010 lists no proposal.status gate here).
  describe("addBudget (DP-007, AUTH-010 proposal:budget:add)", () => {
    it("rejects an inactive citizen", async () => {
      const { svc } = service({ active: [OTHER] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.addBudget(citizenId, proposalId, { cost: 100 })).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a missing proposal", async () => {
      const { svc } = service();
      await expect(svc.addBudget(citizenId, randomUUID(), { cost: 1 })).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("forbids a non-author from adding budget info", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.addBudget(OTHER, proposalId, { cost: 1 })).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("has no status gate -- succeeds even once the proposal is archived", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "archived" });
      const budget = await svc.addBudget(citizenId, proposalId, { cost: 500 });
      expect(budget.cost).toBe(500);
    });

    it("creates then updates the same budget row, merging fields (DP-007 create-or-update)", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });

      const created = await svc.addBudget(citizenId, proposalId, { cost: 100, fundingSource: "grant" });
      expect(created.cost).toBe(100);
      expect(created.fundingSource).toBe("grant");
      expect(created.maintenanceCost).toBeNull();

      const updated = await svc.addBudget(citizenId, proposalId, { maintenanceCost: 20 });
      expect(updated.id).toBe(created.id);
      expect(updated.cost).toBe(100);
      expect(updated.fundingSource).toBe("grant");
      expect(updated.maintenanceCost).toBe(20);
    });
  });

  // DP-020: scope_challenge:file -- scope jurisdiction:affected, condition
  // citizen.active.
  describe("fileScopeChallenge (DP-020, AUTH-010 scope_challenge:file)", () => {
    it("rejects an inactive citizen", async () => {
      const { svc } = service({ active: [] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, scopeJurisdictionId: jurisdictionId });
      await expect(svc.fileScopeChallenge(citizenId, proposalId)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a missing proposal", async () => {
      const { svc } = service();
      await expect(svc.fileScopeChallenge(citizenId, randomUUID())).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("throws InvalidStateDomainError when no scope jurisdiction is assigned yet", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.fileScopeChallenge(citizenId, proposalId)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("forbids a citizen who is not affected by the assigned jurisdiction", async () => {
      const { svc } = service({ affected: [] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, scopeJurisdictionId: jurisdictionId });
      await expect(svc.fileScopeChallenge(citizenId, proposalId)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("files the challenge for an affected citizen, setting scopeChallengedAt", async () => {
      const { svc } = service({ affected: [[citizenId, jurisdictionId]] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, scopeJurisdictionId: jurisdictionId });

      const challenged = await svc.fileScopeChallenge(citizenId, proposalId);
      expect(challenged.scopeChallengedAt).not.toBeNull();
    });
  });

  // DP-028, via the PROPOSAL_SUPPORT_RECOMPUTER port -- pure recompute, no
  // status transition (DP-029 out of scope, ADR-030).
  describe("recomputeForProblem (DP-028, ProposalSupportRecomputer port)", () => {
    it("is a no-op when no proposal is linked to the problem", async () => {
      const { svc } = service();
      await expect(svc.recomputeForProblem(randomUUID())).resolves.toBeUndefined();
    });

    it("sets supportCount from the current problem_support count for a single linked proposal", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      const supporterA = randomUUID();
      const supporterB = randomUUID();
      await insertCitizen(supporterA, "supporter-a");
      await insertCitizen(supporterB, "supporter-b");
      await insertProblemSupport(problemId, supporterA);
      await insertProblemSupport(problemId, supporterB);

      await svc.recomputeForProblem(problemId);
      const updated = await svc.findById(proposalId);
      expect(updated.supportCount).toBe(2);
    });

    it("updates every proposal linked to the problem to the same count", async () => {
      const { svc } = service();
      const first = await insertProposal({ problemId, authorId: citizenId });
      const second = await insertProposal({ problemId, authorId: citizenId });
      const unrelatedProblemId = randomUUID();
      await insertProblem(unrelatedProblemId, citizenId, jurisdictionId);
      const unrelated = await insertProposal({ problemId: unrelatedProblemId, authorId: citizenId });
      const supporterA = randomUUID();
      await insertCitizen(supporterA, "supporter-a");
      await insertProblemSupport(problemId, supporterA);

      await svc.recomputeForProblem(problemId);

      expect((await svc.findById(first)).supportCount).toBe(1);
      expect((await svc.findById(second)).supportCount).toBe(1);
      expect((await svc.findById(unrelated)).supportCount).toBe(0);
    });

    it("is idempotent -- calling it twice yields the same support_count", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      const supporterA = randomUUID();
      await insertCitizen(supporterA, "supporter-a");
      await insertProblemSupport(problemId, supporterA);

      await svc.recomputeForProblem(problemId);
      await svc.recomputeForProblem(problemId);

      expect((await svc.findById(proposalId)).supportCount).toBe(1);
    });
  });

  describe("findById / findAll", () => {
    it("findById throws NotFoundDomainError when missing", async () => {
      const { svc } = service();
      await expect(svc.findById(randomUUID())).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("findById returns the proposal when present", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.findById(proposalId)).resolves.toMatchObject({ id: proposalId });
    });

    it("findAll returns every proposal, optionally filtered by problemId (FR-018)", async () => {
      const { svc } = service();
      const otherProblemId = randomUUID();
      await insertProblem(otherProblemId, citizenId, jurisdictionId);
      await insertProposal({ problemId, authorId: citizenId });
      await insertProposal({ problemId: otherProblemId, authorId: citizenId });

      expect(await svc.findAll()).toHaveLength(2);
      expect(await svc.findAll({ problemId })).toHaveLength(1);
    });
  });
});
