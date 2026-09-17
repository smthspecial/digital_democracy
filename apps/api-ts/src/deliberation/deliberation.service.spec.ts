import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { DeliberationService } from "./deliberation.service.js";

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

// No citizen/jurisdiction/problem/proposal row can be created through this
// module's own service methods -- fixtures go in directly via the admin
// connection, the same way project.service.spec.ts seeds rows no
// ProjectService method can create either.
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

async function insertProposal(id: string, problemId: string, authorId: string): Promise<void> {
  await withAdmin((client) =>
    client.query(
      `INSERT INTO proposal (id, problem_id, author_id, title, description, support_threshold)
       VALUES ($1, $2, $3, 'Proposal', 'Description', 10)`,
      [id, problemId, authorId],
    ),
  );
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises deliberation_argument/preference's RLS policies rather
// than just their SQL text, mirroring project.service.spec.ts.
// DeliberationService now owns its Prisma calls directly (no repository
// indirection) -- these tests drive it through its public API only, not
// internal query helpers.
describe.skipIf(!urls)("DeliberationService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: DeliberationService;
  let citizenStatus: CitizenStatusChecker;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let authorId: string;
  let otherId: string;
  let jurisdictionId: string;
  let problemId: string;
  let proposalId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    authorId = randomUUID();
    otherId = randomUUID();
    jurisdictionId = randomUUID();
    problemId = randomUUID();
    proposalId = randomUUID();
    await insertCitizen(authorId, "alice");
    await insertCitizen(otherId, "bob");
    await insertJurisdiction(jurisdictionId, "Municipality");
    await insertProblem(problemId, authorId, jurisdictionId);
    await insertProposal(proposalId, problemId, authorId);

    const activeCitizens = new Set([authorId, otherId]);
    citizenStatus = {
      isActive: vi.fn(async (citizenId: string) => activeCitizens.has(citizenId)),
    };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new DeliberationService(prisma, citizenStatus, audit);
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  // DP-008: argument:post -- scope any, conditions citizen.active +
  // evidence.required (AUTH-010).
  describe("postArgument (DP-008, AUTH-010 argument:post)", () => {
    it("posts an argument authored by the calling citizen (deliberation_argument_own_insert)", async () => {
      const argument = await svc.postArgument(authorId, {
        proposalId,
        stance: "agreement",
        body: "This helps the budget.",
        evidenceRef: "study-1",
      });
      expect(argument.authorId).toBe(authorId);
      expect(argument.proposalId).toBe(proposalId);
      expect(argument.stance).toBe("agreement");
      expect(argument.evidenceRef).toBe("study-1");
      expect(argument.parentId).toBeNull();
    });

    it("threads a reply via parentId (FR-033)", async () => {
      const parent = await svc.postArgument(authorId, {
        proposalId,
        stance: "agreement",
        body: "Root argument.",
        evidenceRef: "study-1",
      });
      const reply = await svc.postArgument(otherId, {
        proposalId,
        parentId: parent.id,
        stance: "disagreement",
        body: "Reply argument.",
        evidenceRef: "study-2",
      });
      expect(reply.parentId).toBe(parent.id);
    });

    it("rejects an inactive citizen", async () => {
      await expect(
        svc.postArgument(randomUUID(), { proposalId, stance: "agreement", body: "x", evidenceRef: "e" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("emits exactly one audit event on posting (SRV-006 Dependencies: emits DP-036)", async () => {
      const argument = await svc.postArgument(authorId, {
        proposalId,
        stance: "agreement",
        body: "x",
        evidenceRef: "e",
      });
      expect(audit.emit).toHaveBeenCalledTimes(1);
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "deliberation.argument_posted", actorRef: authorId }),
      );
      expect(audit.emit.mock.calls[0][0].payload).toMatchObject({
        argumentId: argument.id,
        proposalId: argument.proposalId,
      });
    });

    it("maps a foreign-key violation on proposalId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.postArgument(authorId, { proposalId: randomUUID(), stance: "agreement", body: "b", evidenceRef: "e" }),
      ).rejects.toThrow(/not found/i);
    });

    it("maps a foreign-key violation on parentId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.postArgument(authorId, {
          proposalId,
          parentId: randomUUID(),
          stance: "agreement",
          body: "b",
          evidenceRef: "e",
        }),
      ).rejects.toThrow(/not found/i);
    });
  });

  // DP-009: preference:declare -- scope any, condition citizen.active only
  // (AUTH-010).
  describe("declarePreference (DP-009, AUTH-010 preference:declare)", () => {
    it("declares a preference for the calling citizen (preference_own_insert)", async () => {
      const preference = await svc.declarePreference(authorId, {
        problemId,
        desiredOutcome: "Fewer potholes",
      });
      expect(preference.citizenId).toBe(authorId);
      expect(preference.problemId).toBe(problemId);
      expect(preference.desiredOutcome).toBe("Fewer potholes");
    });

    it("rejects an inactive citizen", async () => {
      await expect(svc.declarePreference(randomUUID(), { problemId, desiredOutcome: "x" })).rejects.toBeInstanceOf(
        ForbiddenDomainError,
      );
    });

    it("emits no audit event (no DP doc or SRV-006 Dependencies line states one)", async () => {
      await svc.declarePreference(authorId, { problemId, desiredOutcome: "x" });
      expect(audit.emit).not.toHaveBeenCalled();
    });

    it("allows more than one preference per citizen on the same problem (no uniqueness constraint, TBL-018)", async () => {
      await svc.declarePreference(authorId, { problemId, desiredOutcome: "first" });
      const second = await svc.declarePreference(authorId, { problemId, desiredOutcome: "second" });
      expect(second.desiredOutcome).toBe("second");
      expect(await svc.listPreferences({ problemId })).toHaveLength(2);
    });

    it("maps a foreign-key violation on problemId to NotFoundDomainError (P2003)", async () => {
      await expect(
        svc.declarePreference(authorId, { problemId: randomUUID(), desiredOutcome: "x" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("listArguments / listPreferences", () => {
    it("listArguments returns every argument, optionally filtered by proposalId (FR-028, public read)", async () => {
      const otherProposalId = randomUUID();
      await insertProposal(otherProposalId, problemId, authorId);
      await svc.postArgument(authorId, { proposalId, stance: "agreement", body: "a", evidenceRef: "e" });
      await svc.postArgument(authorId, { proposalId: otherProposalId, stance: "agreement", body: "b", evidenceRef: "e" });

      expect(await svc.listArguments()).toHaveLength(2);
      expect(await svc.listArguments({ proposalId })).toHaveLength(1);
    });

    it("listPreferences returns every preference, optionally filtered by problemId (FR-030, public read)", async () => {
      const otherProblemId = randomUUID();
      await insertProblem(otherProblemId, authorId, jurisdictionId);
      await svc.declarePreference(authorId, { problemId, desiredOutcome: "a" });
      await svc.declarePreference(authorId, { problemId: otherProblemId, desiredOutcome: "b" });

      expect(await svc.listPreferences()).toHaveLength(2);
      expect(await svc.listPreferences({ problemId })).toHaveLength(1);
    });
  });

  describe("lockArgument (FR-033/ADR-036 D34, E5-03)", () => {
    async function insertAssignment(citizenId: string, targetRef: string): Promise<void> {
      await withAdmin((client) =>
        client.query(
          `INSERT INTO civic_assignment (id, citizen_id, type, target_ref, due_at) VALUES ($1, $2, 'proposal_review', $3, now() + interval '7 days')`,
          [randomUUID(), citizenId, targetRef],
        ),
      );
    }

    it("throws NotFoundDomainError for an unknown argument", async () => {
      await expect(svc.lockArgument(authorId, randomUUID())).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("rejects a citizen with no proposal_review assignment for this proposal", async () => {
      const argument = await svc.postArgument(authorId, { proposalId, stance: "agreement", body: "b", evidenceRef: "e" });
      await expect(svc.lockArgument(otherId, argument.id)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects locking a disagreement-stance argument (ADR-036 D34: agreement only)", async () => {
      const argument = await svc.postArgument(authorId, { proposalId, stance: "disagreement", body: "b", evidenceRef: "e" });
      await insertAssignment(otherId, proposalId);
      await expect(svc.lockArgument(otherId, argument.id)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("locks an agreement-stance argument for a citizen with an active proposal_review assignment", async () => {
      const argument = await svc.postArgument(authorId, { proposalId, stance: "agreement", body: "b", evidenceRef: "e" });
      await insertAssignment(otherId, proposalId);

      const locked = await svc.lockArgument(otherId, argument.id);
      expect(locked.locked).toBe(true);
      expect(locked.lockedAt).not.toBeNull();
    });

    it("is idempotent -- locking an already-locked argument succeeds without a fresh authority check", async () => {
      const argument = await svc.postArgument(authorId, { proposalId, stance: "agreement", body: "b", evidenceRef: "e" });
      await insertAssignment(otherId, proposalId);
      await svc.lockArgument(otherId, argument.id);

      // No assignment for authorId -- if this weren't idempotent it would throw ForbiddenDomainError.
      const relocked = await svc.lockArgument(authorId, argument.id);
      expect(relocked.locked).toBe(true);
    });

    it("blocks a new reply beneath a locked argument", async () => {
      const argument = await svc.postArgument(authorId, { proposalId, stance: "agreement", body: "b", evidenceRef: "e" });
      await insertAssignment(otherId, proposalId);
      await svc.lockArgument(otherId, argument.id);

      await expect(
        svc.postArgument(authorId, { proposalId, parentId: argument.id, stance: "disagreement", body: "reply", evidenceRef: "e" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("allows a reply beneath an unlocked argument", async () => {
      const argument = await svc.postArgument(authorId, { proposalId, stance: "agreement", body: "b", evidenceRef: "e" });
      const reply = await svc.postArgument(authorId, {
        proposalId, parentId: argument.id, stance: "disagreement", body: "reply", evidenceRef: "e",
      });
      expect(reply.parentId).toBe(argument.id);
    });
  });
});
