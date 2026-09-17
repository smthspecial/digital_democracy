import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import type { JurisdictionMembershipChecker } from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { computeSupportThreshold, ProposalService } from "./proposal.service.js";
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

async function insertJurisdiction(id: string, name: string, population: number | null = 200): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO jurisdiction (id, name, scope_level, boundary_ref, population) VALUES ($1, $2, 'municipality', $3, $4)`,
      [id, name, `ref-${id}`, population],
    ),
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

  function service(opts?: {
    active?: string[];
    affected?: Array<[string, string]>;
    constitutionallyCleared?: boolean;
    reviewBodyHolders?: string[];
  }) {
    const activeCitizens = new Set(opts?.active ?? [citizenId, OTHER]);
    const affectedPairs = new Set((opts?.affected ?? []).map(([cid, jid]) => `${cid}:${jid}`));

    const citizenStatus: CitizenStatusChecker = {
      isActive: vi.fn(async (id: string) => activeCitizens.has(id)),
    };
    const jurisdictionMembership: JurisdictionMembershipChecker = {
      isMember: vi.fn(async () => false),
      isAffected: vi.fn(async (cid: string, jid: string) => affectedPairs.has(`${cid}:${jid}`)),
      isEligible: vi.fn(async () => false),
    };
    const audit = { emit: vi.fn().mockResolvedValue(undefined) };
    const constitutionalReviewer = { isCleared: vi.fn(async () => opts?.constitutionallyCleared ?? false) };
    const reviewBodyHolders = new Set(opts?.reviewBodyHolders ?? []);
    const governanceRole: GovernanceRoleChecker = {
      isActiveHolder: vi.fn(async (cid: string, roleType: string) => roleType === "review_body" && reviewBodyHolders.has(cid)),
    };

    const svc = new ProposalService(prisma, citizenStatus, jurisdictionMembership, audit, constitutionalReviewer, governanceRole);
    return { svc, citizenStatus, jurisdictionMembership, audit, activeCitizens };
  }

  // DP-005: proposal:create -- scope any, condition citizen.active.
  describe("create (DP-005, AUTH-010 proposal:create)", () => {
    it("creates a draft proposal authored by the calling citizen, with a population-derived threshold", async () => {
      const { svc } = service();
      const proposal = await svc.create(citizenId, {
        problemId,
        title: "Fix the pothole",
        description: "Repave the street",
      });
      expect(proposal.status).toBe("draft");
      expect(proposal.authorId).toBe(citizenId);
      expect(proposal.supportCount).toBe(0);
      expect(proposal.supportThreshold).toBe(10);
    });

    it("emits DP-036 on creation", async () => {
      const { svc, audit } = service();
      const proposal = await svc.create(citizenId, { problemId, title: "T", description: "D" });
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: expect.stringContaining("proposal"), actorRef: citizenId }),
      );
      expect(audit.emit.mock.calls[0][0].payload).toMatchObject({ proposalId: proposal.id });
    });

    it("rejects an inactive citizen", async () => {
      const { svc } = service({ active: [] });
      await expect(svc.create(citizenId, { problemId, title: "T", description: "D" })).rejects.toBeInstanceOf(
        ForbiddenDomainError,
      );
    });

    // Ported from the deleted proposal.repository.prisma.spec.ts -- the old
    // InMemoryProposalRepository never modeled a problem table, so this
    // foreign-key mapping (problem_id -> NotFoundDomainError) had no
    // in-memory equivalent; reachable through create()'s public API, so
    // kept (mirrors ProjectService's own ported NotFoundDomainError cases).
    it("throws NotFoundDomainError when problemId does not reference an existing problem", async () => {
      const { svc } = service();
      await expect(
        svc.create(citizenId, { problemId: randomUUID(), title: "T", description: "D" }),
      ).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    // ADR-035 D15: refuse rather than silently default.
    it("throws InvalidStateDomainError when the problem's jurisdiction has no recorded population", async () => {
      const { svc } = service();
      const noPopJurisdictionId = randomUUID();
      const noPopProblemId = randomUUID();
      await insertJurisdiction(noPopJurisdictionId, "No Population Data", null);
      await insertProblem(noPopProblemId, citizenId, noPopJurisdictionId);

      await expect(
        svc.create(citizenId, { problemId: noPopProblemId, title: "T", description: "D" }),
      ).rejects.toBeInstanceOf(InvalidStateDomainError);
    });
  });

  describe("computeSupportThreshold (ADR-035 D14/D15, pure)", () => {
    it("scales with population at the configured rate", () => {
      expect(computeSupportThreshold({ population: 10000, supportRateBps: 500, minThreshold: 10, maxThreshold: null })).toBe(500);
    });

    it("clamps up to minThreshold for a small population", () => {
      expect(computeSupportThreshold({ population: 10, supportRateBps: 500, minThreshold: 50, maxThreshold: null })).toBe(50);
    });

    it("clamps down to maxThreshold for a large population", () => {
      expect(computeSupportThreshold({ population: 1_000_000, supportRateBps: 500, minThreshold: 10, maxThreshold: 5000 })).toBe(5000);
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

  describe("listConstraints (public read, EPIC-005)", () => {
    it("returns every constraint added to a proposal", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await svc.addConstraint(citizenId, proposalId, { text: "no new taxes" });
      await svc.addConstraint(citizenId, proposalId, { text: "must be carbon neutral" });

      const constraints = await svc.listConstraints(proposalId);
      expect(constraints).toHaveLength(2);
      expect(constraints.map((c) => c.text).sort()).toEqual(["must be carbon neutral", "no new taxes"]);
    });

    it("returns an empty array for a proposal with no constraints", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      expect(await svc.listConstraints(proposalId)).toEqual([]);
    });
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

    it("rejects adding budget info once the proposal is archived (E3-12)", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "archived" });
      await expect(svc.addBudget(citizenId, proposalId, { cost: 500 })).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("allows adding budget info while the proposal is in development (E3-12)", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "development" });
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

  describe("getBudget (public read, US-028)", () => {
    it("returns null when the author has never submitted budget info", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      expect(await svc.getBudget(proposalId)).toBeNull();
    });

    it("returns the budget row once submitted", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await svc.addBudget(citizenId, proposalId, { cost: 500, fundingSource: "grant", longTermCost: 50 });

      const budget = await svc.getBudget(proposalId);
      expect(budget?.cost).toBe(500);
      expect(budget?.fundingSource).toBe("grant");
      expect(budget?.longTermCost).toBe(50);
    });
  });

  // DP-020: scope_challenge:file -- scope jurisdiction:affected, condition
  // citizen.active.
  describe("fileScopeChallenge (DP-020, AUTH-010 scope_challenge:file)", () => {
    it("rejects an inactive citizen", async () => {
      const { svc } = service({ active: [] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, scopeJurisdictionId: jurisdictionId });
      await expect(svc.fileScopeChallenge(citizenId, proposalId, "reason")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a missing proposal", async () => {
      const { svc } = service();
      await expect(svc.fileScopeChallenge(citizenId, randomUUID(), "reason")).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("throws InvalidStateDomainError when no scope jurisdiction is assigned yet", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.fileScopeChallenge(citizenId, proposalId, "reason")).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("forbids a citizen who is not affected by the assigned jurisdiction", async () => {
      const { svc } = service({ affected: [] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, scopeJurisdictionId: jurisdictionId });
      await expect(svc.fileScopeChallenge(citizenId, proposalId, "reason")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("files the challenge for an affected citizen, setting scopeChallengedAt and a ScopeChallenge row", async () => {
      const { svc } = service({ affected: [[citizenId, jurisdictionId]] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, scopeJurisdictionId: jurisdictionId });

      const challenged = await svc.fileScopeChallenge(citizenId, proposalId, "boundary is wrong");
      expect(challenged.scopeChallengedAt).not.toBeNull();

      const challenges = await svc.listScopeChallenges(proposalId);
      expect(challenges).toHaveLength(1);
      expect(challenges[0]).toMatchObject({ challengerId: citizenId, reason: "boundary is wrong", status: "open" });
    });
  });

  describe("assignScope (ADR-038 D10, E2-05)", () => {
    it("rejects a non-review_body actor", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId });
      await expect(svc.assignScope(citizenId, proposalId, jurisdictionId, "rationale")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  describe("resolveScopeChallenge (ADR-038 D10, E2-08)", () => {
    it("rejects a non-review_body actor", async () => {
      const { svc } = service();
      await expect(svc.resolveScopeChallenge(citizenId, randomUUID(), "upheld", "x")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  // DP-028, via the PROPOSAL_SUPPORT_RECOMPUTER port. Also checks every
  // affected proposal for the gathering_support -> development threshold
  // crossing (DP-029, ADR-035 D16 -- system-triggered).
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

    it("transitions gathering_support -> development once support_count reaches the threshold", async () => {
      const { svc, audit } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "gathering_support", supportThreshold: 2 });
      const a = randomUUID();
      const b = randomUUID();
      await insertCitizen(a, "a");
      await insertCitizen(b, "b");
      await insertProblemSupport(problemId, a);
      await insertProblemSupport(problemId, b);

      await svc.recomputeForProblem(problemId);

      expect((await svc.findById(proposalId)).status).toBe("development");
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "proposal.status_changed", payload: expect.objectContaining({ proposalId, status: "development" }) }),
      );
    });

    it("does not transition below the threshold", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "gathering_support", supportThreshold: 5 });
      const a = randomUUID();
      await insertCitizen(a, "a");
      await insertProblemSupport(problemId, a);

      await svc.recomputeForProblem(problemId);

      expect((await svc.findById(proposalId)).status).toBe("gathering_support");
    });

    it("does not transition a proposal that is not in gathering_support", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "draft", supportThreshold: 1 });
      const a = randomUUID();
      await insertCitizen(a, "a");
      await insertProblemSupport(problemId, a);

      await svc.recomputeForProblem(problemId);

      expect((await svc.findById(proposalId)).status).toBe("draft");
    });
  });

  // DP-029/ADR-035: the one shared author-triggered transition function.
  describe("advance (DP-029, ADR-035)", () => {
    it("draft -> gathering_support is always allowed for the author", async () => {
      const { svc, audit } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "draft" });

      const updated = await svc.advance(citizenId, proposalId);

      expect(updated.status).toBe("gathering_support");
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "proposal.status_changed", actorRef: citizenId }),
      );
    });

    it("rejects a non-author", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "draft" });
      await expect(svc.advance(OTHER, proposalId)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects advancing from gathering_support -- system-only transition", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "gathering_support" });
      await expect(svc.advance(citizenId, proposalId)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("rejects development -> voting when no scope is assigned (ADR-038 D11/E2-09)", async () => {
      const { svc } = service({ constitutionallyCleared: true });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "development" });
      await expect(svc.advance(citizenId, proposalId)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("rejects development -> voting while a scope challenge is open (E2-09)", async () => {
      const { svc } = service({ constitutionallyCleared: true, affected: [[citizenId, jurisdictionId]] });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "development", scopeJurisdictionId: jurisdictionId });
      await svc.fileScopeChallenge(citizenId, proposalId, "wrong scope");
      await expect(svc.advance(citizenId, proposalId)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("rejects development -> voting when the constitutional reviewer has not cleared it (fail-closed default)", async () => {
      const { svc } = service({ constitutionallyCleared: false });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "development", scopeJurisdictionId: jurisdictionId });
      await expect(svc.advance(citizenId, proposalId)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("allows development -> voting once scope is assigned, no open challenge, and the constitutional reviewer clears it", async () => {
      const { svc } = service({ constitutionallyCleared: true });
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "development", scopeJurisdictionId: jurisdictionId });
      const updated = await svc.advance(citizenId, proposalId);
      expect(updated.status).toBe("voting");
    });

    it("rejects advancing a terminal-status proposal (voting)", async () => {
      const { svc } = service();
      const proposalId = await insertProposal({ problemId, authorId: citizenId, status: "voting" });
      await expect(svc.advance(citizenId, proposalId)).rejects.toBeInstanceOf(InvalidStateDomainError);
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
