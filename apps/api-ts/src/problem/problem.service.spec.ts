import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictDomainError, ForbiddenDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import type { JurisdictionMembershipChecker } from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ProposalSupportRecomputer } from "../proposal/proposal-support.port.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { ProblemService } from "./problem.service.js";

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

async function insertProblem(id: string, authorId: string, jurisdictionId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO problem (id, author_id, title, description, affected_area, jurisdiction_id)
       VALUES ($1, $2, 'Potholes', 'Too many potholes', 'Main St', $3)`,
      [id, authorId, jurisdictionId],
    ),
  );
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises problem/problem_support's RLS policies rather than just
// their SQL text, mirroring project.service.spec.ts. ProblemService now
// owns its Prisma calls directly (no repository indirection) -- these
// tests drive it through its public API only, not internal query helpers.
describe.skipIf(!urls)("ProblemService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: ProblemService;
  let citizenStatus: CitizenStatusChecker;
  let jurisdictionMembership: JurisdictionMembershipChecker;
  let proposalSupport: ProposalSupportRecomputer;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let activeCitizens: Set<string>;
  let memberPairs: Set<string>;
  let authorId: string;
  let endorserId: string;
  let jurisdictionId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    authorId = randomUUID();
    endorserId = randomUUID();
    jurisdictionId = randomUUID();
    await insertCitizen(authorId, "author");
    await insertCitizen(endorserId, "endorser");
    await insertJurisdiction(jurisdictionId, "Municipality");

    activeCitizens = new Set([authorId, endorserId]);
    memberPairs = new Set([`${endorserId}:${jurisdictionId}`]);
    citizenStatus = { isActive: vi.fn(async (citizenId: string) => activeCitizens.has(citizenId)) };
    jurisdictionMembership = {
      isMember: vi.fn(async (citizenId: string, jid: string) => memberPairs.has(`${citizenId}:${jid}`)),
      isAffected: vi.fn(async () => false),
    };
    proposalSupport = { recomputeForProblem: vi.fn().mockResolvedValue(undefined) };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };

    svc = new ProblemService(prisma, citizenStatus, jurisdictionMembership, proposalSupport, audit);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // Seeds a problem directly via raw SQL (bypassing svc.submit, so tests
  // that assert on submit()'s own side effects -- audit emit counts --
  // aren't polluted by fixture setup).
  async function seedProblem(overrides: Partial<{ authorId: string; jurisdictionId: string }> = {}): Promise<string> {
    const id = randomUUID();
    await insertProblem(id, overrides.authorId ?? authorId, overrides.jurisdictionId ?? jurisdictionId);
    return id;
  }

  // DP-003: problem:create -- scope any, condition citizen.active (AUTH-010).
  describe("submit (DP-003, AUTH-010 problem:create)", () => {
    it("creates an open problem authored by the calling citizen", async () => {
      const problem = await svc.submit(authorId, {
        title: "Pothole",
        description: "Big pothole",
        affectedArea: "Main St",
        jurisdictionId,
        evidenceKind: "statement",
        evidenceRef: "I saw it myself",
      });
      expect(problem.status).toBe("open");
      expect(problem.authorId).toBe(authorId);
      expect(problem.jurisdictionId).toBe(jurisdictionId);
    });

    it("emits exactly one audit event on creation", async () => {
      const problem = await svc.submit(authorId, { title: "T", description: "D", affectedArea: "A", jurisdictionId, evidenceKind: "statement", evidenceRef: "e" });
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: expect.stringContaining("problem"), actorRef: authorId }),
      );
      expect(audit.emit.mock.calls[0][0].payload).toMatchObject({ problemId: problem.id });
    });

    it("rejects an inactive citizen", async () => {
      activeCitizens.delete(authorId);
      await expect(
        svc.submit(authorId, { title: "T", description: "D", affectedArea: "A", jurisdictionId, evidenceKind: "statement", evidenceRef: "e" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  // DP-004: problem:endorse -- scope jurisdiction:member, conditions
  // citizen.active + unique:(citizen,problem) (AUTH-010).
  describe("endorse (DP-004, AUTH-010 problem:endorse)", () => {
    it("rejects an inactive citizen", async () => {
      const problemId = await seedProblem();
      activeCitizens.delete(endorserId);
      await expect(svc.endorse(endorserId, problemId)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a missing problem", async () => {
      await expect(svc.endorse(endorserId, randomUUID())).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("rejects endorsement when the citizen is not a jurisdiction member (jurisdiction:member)", async () => {
      const problemId = await seedProblem();
      memberPairs.clear();
      await expect(svc.endorse(endorserId, problemId)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects a duplicate endorsement (unique:(citizen,problem))", async () => {
      const problemId = await seedProblem();
      await svc.endorse(endorserId, problemId);
      await expect(svc.endorse(endorserId, problemId)).rejects.toBeInstanceOf(ConflictDomainError);
    });

    it("succeeds for a jurisdiction member, returning the problem and new support row", async () => {
      const problemId = await seedProblem();

      const result = await svc.endorse(endorserId, problemId);
      expect(result.problem.id).toBe(problemId);
      expect(result.support.problemId).toBe(problemId);
      expect(result.support.citizenId).toBe(endorserId);
    });

    it("calls the PROPOSAL_SUPPORT_RECOMPUTER port exactly once with the endorsed problemId (DP-028)", async () => {
      const problemId = await seedProblem();

      await svc.endorse(endorserId, problemId);
      expect(proposalSupport.recomputeForProblem).toHaveBeenCalledTimes(1);
      expect(proposalSupport.recomputeForProblem).toHaveBeenCalledWith(problemId);
    });

    it("emits no audit event on endorsement", async () => {
      const problemId = await seedProblem();
      await svc.endorse(endorserId, problemId);
      expect(audit.emit).not.toHaveBeenCalled();
    });
  });

  describe("findById / findAll", () => {
    it("findById throws NotFoundDomainError when missing", async () => {
      await expect(svc.findById(randomUUID())).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("findById returns the problem when present", async () => {
      const problemId = await seedProblem();
      await expect(svc.findById(problemId)).resolves.toMatchObject({ id: problemId });
    });

    it("findAll returns every problem (FR-016 public listing)", async () => {
      await seedProblem();
      await seedProblem();
      expect(await svc.findAll()).toHaveLength(2);
    });
  });

  describe("submit requires evidence (E3-02/ADR-035 D18)", () => {
    it("creates a ProblemEvidence row alongside the problem", async () => {
      const problem = await svc.submit(authorId, {
        title: "T", description: "D", affectedArea: "A", jurisdictionId,
        evidenceKind: "statement", evidenceRef: "witnessed it",
      });
      const evidence = await svc.listEvidence(problem.id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ kind: "statement", ref: "witnessed it", citizenId: authorId });
    });
  });

  describe("addEvidence (E3-02, post-submission)", () => {
    it("adds a second evidence row for an existing problem", async () => {
      const problemId = await seedProblem();
      await svc.addEvidence(authorId, problemId, "link", "https://example.com/proof");
      const evidence = await svc.listEvidence(problemId);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ kind: "link", ref: "https://example.com/proof" });
    });

    it("rejects an inactive citizen", async () => {
      activeCitizens.delete(authorId);
      const problemId = await seedProblem();
      await expect(svc.addEvidence(authorId, problemId, "statement", "x")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a missing problem", async () => {
      await expect(svc.addEvidence(authorId, randomUUID(), "statement", "x")).rejects.toBeInstanceOf(NotFoundDomainError);
    });
  });

  describe("addComment / listComments (E3-04/US-011)", () => {
    it("adds and lists comments in creation order", async () => {
      const problemId = await seedProblem();
      await svc.addComment(authorId, problemId, "first");
      await svc.addComment(authorId, problemId, "second");
      const comments = await svc.listComments(problemId);
      expect(comments.map((c) => c.body)).toEqual(["first", "second"]);
    });

    it("rejects an inactive citizen", async () => {
      activeCitizens.delete(authorId);
      const problemId = await seedProblem();
      await expect(svc.addComment(authorId, problemId, "x")).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("throws NotFoundDomainError for a missing problem", async () => {
      await expect(svc.addComment(authorId, randomUUID(), "x")).rejects.toBeInstanceOf(NotFoundDomainError);
    });
  });
});
