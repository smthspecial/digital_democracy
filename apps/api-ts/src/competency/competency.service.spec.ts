import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError } from "../common/domain-errors.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { CompetencyService } from "./competency.service.js";

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

async function insertDomain(id: string, name: string, description = "Scope"): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO expert_domain (id, name, description) VALUES ($1, $2, $3)`, [id, name, description]),
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

async function insertCompetency(
  id: string,
  citizenId: string,
  domainId: string,
  status: "applied" | "active" = "active",
): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO competency (id, citizen_id, domain_id, level, status, evidence_ref) VALUES ($1, $2, $3, 2, $4, $5)`, [
      id,
      citizenId,
      domainId,
      status,
      'evidence-fixture',
    ]),
  );
}

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises expert_domain/competency/conflict_of_interest/
// competency_challenge/expert_assessment's RLS policies rather than just
// their SQL text, mirroring project.service.spec.ts. CompetencyService now
// owns its Prisma calls directly (no repository indirection) -- these tests
// drive it through its public API only, not internal query helpers.
describe.skipIf(!urls)("CompetencyService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: CompetencyService;
  let citizenStatus: CitizenStatusChecker;
  let CITIZEN: string;
  let OTHER: string;
  let INACTIVE: string;
  let DOMAIN: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    CITIZEN = randomUUID();
    OTHER = randomUUID();
    INACTIVE = randomUUID();
    DOMAIN = randomUUID();

    const activeCitizens = new Set([CITIZEN, OTHER]);
    citizenStatus = {
      isActive: vi.fn(async (citizenId: string) => activeCitizens.has(citizenId)),
    };
    svc = new CompetencyService(prisma, citizenStatus);

    await insertCitizen(CITIZEN, "alice");
    await insertCitizen(OTHER, "bob");
    await insertCitizen(INACTIVE, "carol");
    await insertDomain(DOMAIN, "Transportation");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  async function seedActiveCompetency(citizenId: string = CITIZEN, domainId: string = DOMAIN): Promise<string> {
    const id = randomUUID();
    await insertCompetency(id, citizenId, domainId, "active");
    return id;
  }

  // DP-011: competency:apply -- scope any, condition citizen.active.
  describe("apply (DP-011, AUTH-010 competency:apply)", () => {
    it("creates a competency row with status=applied", async () => {
      const competency = await svc.apply(CITIZEN, { domainId: DOMAIN, level: 2, evidenceRef: "evidence-1" });
      expect(competency.status).toBe("applied");
      expect(competency.citizenId).toBe(CITIZEN);
      expect(competency.domainId).toBe(DOMAIN);
      expect(competency.level).toBe(2);
    });

    it("rejects an inactive citizen", async () => {
      await expect(svc.apply(INACTIVE, { domainId: DOMAIN, level: 2, evidenceRef: "evidence-1" })).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  // DP-010: coi:declare -- scope own, condition citizen.active ONLY
  // (AUTH-010's actual row, not DP-010.md's looser "citizen with active
  // competency" actor-line prose) -- no competency check here.
  describe("declareConflict (DP-010, AUTH-010 coi:declare)", () => {
    it("creates a conflict_of_interest row for a citizen with no competency at all", async () => {
      const conflict = await svc.declareConflict(CITIZEN, {
        domainId: DOMAIN,
        type: "employer",
        description: "Works for a firm in this domain",
      });
      expect(conflict.citizenId).toBe(CITIZEN);
      expect(conflict.domainId).toBe(DOMAIN);
      expect(conflict.type).toBe("employer");

      const rows = await withAdmin((client) =>
        client.query(`SELECT citizen_id, domain_id FROM conflict_of_interest WHERE citizen_id = $1 AND domain_id = $2`, [
          CITIZEN,
          DOMAIN,
        ]),
      );
      expect(rows.rows).toHaveLength(1);
    });

    it("rejects an inactive citizen", async () => {
      await expect(
        svc.declareConflict(INACTIVE, { domainId: DOMAIN, type: "financial", description: "x" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  describe("listConflicts (FR-025 public read)", () => {
    it("is a pass-through, optionally filtered by citizenId/domainId", async () => {
      await svc.declareConflict(CITIZEN, { domainId: DOMAIN, type: "employer", description: "x" });
      await svc.declareConflict(OTHER, { domainId: DOMAIN, type: "financial", description: "y" });

      expect(await svc.listConflicts()).toHaveLength(2);
      expect(await svc.listConflicts({ citizenId: CITIZEN })).toHaveLength(1);
    });
  });

  // DP-012: competency_challenge:submit -- scope any, conditions
  // citizen.active + evidence.required (DTO layer).
  describe("submitChallenge (DP-012, AUTH-010 competency_challenge:submit)", () => {
    it("creates a competency_challenge row with status=open, challenger set from the caller", async () => {
      const competencyId = randomUUID();
      await insertCompetency(competencyId, CITIZEN, DOMAIN, "applied");

      const challenge = await svc.submitChallenge(OTHER, {
        competencyId,
        evidenceRef: "evidence-ref-1",
        reason: "credentials",
      });
      expect(challenge.status).toBe("open");
      expect(challenge.challengerId).toBe(OTHER);
      expect(challenge.competencyId).toBe(competencyId);
    });

    it("rejects an inactive citizen", async () => {
      await expect(
        svc.submitChallenge(INACTIVE, { competencyId: randomUUID(), evidenceRef: "ref", reason: "misconduct" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });
  });

  describe("listChallenges (public read)", () => {
    it("is a pass-through, optionally filtered by competencyId", async () => {
      const competencyId = randomUUID();
      await insertCompetency(competencyId, CITIZEN, DOMAIN, "applied");
      await svc.submitChallenge(OTHER, { competencyId, evidenceRef: "ref", reason: "credentials" });

      expect(await svc.listChallenges()).toHaveLength(1);
      expect(await svc.listChallenges({ competencyId })).toHaveLength(1);
      expect(await svc.listChallenges({ competencyId: randomUUID() })).toHaveLength(0);
    });
  });

  // DP-021 / AUTH-002 assessment:publish -- scope domain:match, conditions
  // citizen.active, competency.active, coi.none. Nothing in this pass can
  // create an active competency through the service itself (DP-031 out of
  // scope), so the happy path is exercised by seeding one directly via the
  // admin connection.
  describe("publish (DP-021, AUTH-002 assessment:publish)", () => {
    it("rejects an inactive citizen", async () => {
      await seedActiveCompetency();
      await expect(
        svc.publish(INACTIVE, {
          proposalId: randomUUID(),
          domainId: DOMAIN,
          technicalScore: 5,
          economicScore: 5,
          socialScore: 5,
          sustainabilityScore: 5,
          body: "Analysis",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects when the citizen has no active competency in any domain", async () => {
      await expect(
        svc.publish(CITIZEN, {
          proposalId: randomUUID(),
          domainId: DOMAIN,
          technicalScore: 5,
          economicScore: 5,
          socialScore: 5,
          sustainabilityScore: 5,
          body: "Analysis",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects when the citizen's active competency is in a DIFFERENT domain than the assessment targets", async () => {
      const otherDomainId = randomUUID();
      await insertDomain(otherDomainId, "Healthcare");
      await seedActiveCompetency(CITIZEN, otherDomainId);
      await expect(
        svc.publish(CITIZEN, {
          proposalId: randomUUID(),
          domainId: DOMAIN,
          technicalScore: 5,
          economicScore: 5,
          socialScore: 5,
          sustainabilityScore: 5,
          body: "Analysis",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects when a conflict_of_interest row exists for that citizen+domain, even with active competency there", async () => {
      await seedActiveCompetency();
      await svc.declareConflict(CITIZEN, {
        domainId: DOMAIN,
        type: "consulting",
        description: "Undisclosed-turned-disclosed interest",
      });
      await expect(
        svc.publish(CITIZEN, {
          proposalId: randomUUID(),
          domainId: DOMAIN,
          technicalScore: 5,
          economicScore: 5,
          socialScore: 5,
          sustainabilityScore: 5,
          body: "Analysis",
        }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("succeeds when an active competency exists in the target domain and no conflict exists", async () => {
      await seedActiveCompetency();
      const jurisdictionId = randomUUID();
      const problemId = randomUUID();
      const proposalId = randomUUID();
      await insertJurisdiction(jurisdictionId, "Municipality");
      await insertProblem(problemId, CITIZEN, jurisdictionId);
      await insertProposal(proposalId, problemId, CITIZEN);

      const assessment = await svc.publish(CITIZEN, {
        proposalId,
        domainId: DOMAIN,
        technicalScore: 7,
        economicScore: 6,
        socialScore: 8,
        sustainabilityScore: 4,
        body: "This proposal is technically sound.",
      });
      expect(assessment.expertId).toBe(CITIZEN);
      expect(assessment.domainId).toBe(DOMAIN);
      expect(assessment.proposalId).toBe(proposalId);
      expect(assessment.body).toBe("This proposal is technically sound.");

      const listed = await svc.listAssessments({ proposalId });
      expect(listed).toHaveLength(1);
    });
  });

  describe("listDomains / listCompetencies / listAssessments", () => {
    it("listDomains passes through the public domain catalog", async () => {
      expect(await svc.listDomains()).toEqual([{ id: DOMAIN, name: "Transportation", description: "Scope" }]);
    });

    it("listCompetencies optionally filters by citizenId/domainId", async () => {
      const otherDomainId = randomUUID();
      await insertDomain(otherDomainId, "Healthcare");
      await svc.apply(CITIZEN, { domainId: DOMAIN, level: 1, evidenceRef: "evidence-1" });
      await svc.apply(OTHER, { domainId: otherDomainId, level: 2, evidenceRef: "evidence-1" });

      expect(await svc.listCompetencies()).toHaveLength(2);
      expect(await svc.listCompetencies({ citizenId: CITIZEN })).toHaveLength(1);
      expect(await svc.listCompetencies({ domainId: otherDomainId })).toHaveLength(1);
    });

    it("listAssessments optionally filters by proposalId", async () => {
      await seedActiveCompetency();
      const jurisdictionId = randomUUID();
      const problemId = randomUUID();
      const proposalId1 = randomUUID();
      const proposalId2 = randomUUID();
      await insertJurisdiction(jurisdictionId, "Municipality");
      await insertProblem(problemId, CITIZEN, jurisdictionId);
      await insertProposal(proposalId1, problemId, CITIZEN);
      await insertProposal(proposalId2, problemId, CITIZEN);

      await svc.publish(CITIZEN, {
        proposalId: proposalId1,
        domainId: DOMAIN,
        technicalScore: 5,
        economicScore: 5,
        socialScore: 5,
        sustainabilityScore: 5,
        body: "Analysis",
      });
      await svc.publish(CITIZEN, {
        proposalId: proposalId2,
        domainId: DOMAIN,
        technicalScore: 5,
        economicScore: 5,
        socialScore: 5,
        sustainabilityScore: 5,
        body: "Analysis 2",
      });

      expect(await svc.listAssessments()).toHaveLength(2);
      expect(await svc.listAssessments({ proposalId: proposalId1 })).toHaveLength(1);
    });
  });
});
