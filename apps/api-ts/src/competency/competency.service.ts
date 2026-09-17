import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { ConflictDomainError, ForbiddenDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  ApplyForCompetencyInput,
  AssessmentListFilter,
  ChallengeListFilter,
  Competency,
  CompetencyChallenge,
  CompetencyChallengeReason,
  CompetencyListFilter,
  ConflictListFilter,
  ConflictOfInterest,
  ConflictOfInterestType,
  DeclareConflictOfInterestInput,
  ExpertAssessment,
  ExpertDomain,
  PublishAssessmentInput,
  SubmitCompetencyChallengeInput,
} from "./competency.types.js";

const FOREIGN_KEY_VIOLATION = "P2003";
const UNIQUE_VIOLATION = "P2002";

export interface ApplyInput {
  domainId: string;
  level: number;
  evidenceRef: string;
}

export interface DeclareConflictInput {
  domainId: string;
  type: ConflictOfInterestType;
  description: string;
}

export interface SubmitChallengeInput {
  competencyId: string;
  evidenceRef: string;
  reason: CompetencyChallengeReason;
}

export interface PublishInput {
  proposalId: string;
  domainId: string;
  technicalScore: number;
  economicScore: number;
  socialScore: number;
  sustainabilityScore: number;
  body: string;
}

// DP-010/011/012/021, SRV-005: talks to Postgres directly via PrismaService's
// dual api_app/api_worker connections (ADR-030) -- no repository indirection.
@Injectable()
export class CompetencyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
  ) {}

  // Public reference-data read -- no citizen.active gate (this is the
  // domain catalog, not a citizen-facing write). expert_domain_public_read
  // is USING(true) for both roles -- no citizen context needed, same as
  // JurisdictionService.getTree's plain app read.
  async listDomains(): Promise<ExpertDomain[]> {
    return this.prisma.app.expertDomain.findMany();
  }

  // DP-011: competency:apply -- scope any, condition citizen.active
  // (AUTH-010). No audit emit (DP-011.md doesn't say "Emits DP-036").
  // Enqueuing DP-031 (the five-stage verification pipeline) is out of scope
  // -- competency.status can only ever be "applied" through this call.
  async apply(citizenId: string, input: ApplyInput): Promise<Competency> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    return this.applyForCompetency({ citizenId, domainId: input.domainId, level: input.level, evidenceRef: input.evidenceRef });
  }

  // DP-010: coi:declare -- scope own, condition citizen.active ONLY
  // (AUTH-010's actual permission row) -- NOT DP-010.md's looser "citizen
  // with active competency" actor-line prose; AUTH-010 is the enforcement
  // contract (schema-phase judgment call, applied here rather than adding a
  // competency check). No audit emit. Enqueuing DP-033 (auto-exclusion) is
  // out of scope -- no side effect beyond the insert.
  async declareConflict(citizenId: string, input: DeclareConflictInput): Promise<ConflictOfInterest> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    return this.declareConflictOfInterest({
      citizenId,
      domainId: input.domainId,
      type: input.type,
      description: input.description,
    });
  }

  // DP-012: competency_challenge:submit -- scope any, conditions
  // citizen.active + evidence.required (evidenceRef non-empty, enforced at
  // the DTO layer). No audit emit. Enqueuing DP-032 (routing) is out of
  // scope.
  async submitChallenge(citizenId: string, input: SubmitChallengeInput): Promise<CompetencyChallenge> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    return this.submitCompetencyChallenge({
      competencyId: input.competencyId,
      challengerId: citizenId,
      evidenceRef: input.evidenceRef,
      reason: input.reason,
    });
  }

  // DP-021 / AUTH-002 assessment:publish -- scope domain:match, conditions
  // citizen.active, competency.active, coi.none. No audit emit (DP-021.md's
  // "Advisory only -- cannot block or delay voting" is a voting-weight
  // statement, not an audit-emission one).
  async publish(citizenId: string, input: PublishInput): Promise<ExpertAssessment> {
    await assertActiveCitizen(this.citizenStatus, citizenId);

    // Public read table; status='active' specifically -- the domain:match +
    // competency.active gate (AUTH-002). This is the service's primary
    // enforcement point: it gives a clean 403 instead of leaving the caller
    // to hit expert_assessment_domain_match_insert's raw RLS violation (that
    // policy re-derives the same fact at the DB layer as a defense-in-depth
    // backstop, not the primary mechanism).
    const activeCompetency = await this.prisma.app.competency.findFirst({
      where: { citizenId, domainId: input.domainId, status: "active" },
    });
    if (!activeCompetency) {
      throw new ForbiddenDomainError("Citizen has no active competency in this domain");
    }

    // conflict_of_interest_public_read is USING(true) -- no citizen context
    // needed (schema-phase judgment call #2: PUBLIC read, ARCH-023 §6's
    // "OWN" describes only the INSERT restriction). Any row for (citizenId,
    // domainId) blocks assessment:publish (coi.none) -- the row IS the
    // disclosure, disclosed or not (schema-phase judgment call #3).
    const conflict = await this.prisma.app.conflictOfInterest.findFirst({
      where: { citizenId, domainId: input.domainId },
    });
    if (conflict) {
      throw new ForbiddenDomainError("Citizen has a disclosed conflict of interest in this domain");
    }

    return this.publishAssessment({
      proposalId: input.proposalId,
      expertId: citizenId,
      domainId: input.domainId,
      technicalScore: input.technicalScore,
      economicScore: input.economicScore,
      socialScore: input.socialScore,
      sustainabilityScore: input.sustainabilityScore,
      body: input.body,
    });
  }

  // competency_public_read is USING(true) -- no citizen context needed,
  // same as ProposalService's own findAll read.
  async listCompetencies(filter?: CompetencyListFilter): Promise<Competency[]> {
    return this.prisma.app.competency.findMany({
      where: {
        ...(filter?.citizenId ? { citizenId: filter.citizenId } : {}),
        ...(filter?.domainId ? { domainId: filter.domainId } : {}),
      },
    });
  }

  // BUG-002 (delegated-expertise seam): apps/api-go/internal/delegation's
  // httpCompetencyChecker already calls this exact route
  // (GET /competency/citizens/:citizenId/domains/:domainId -> {active}) --
  // it just never existed on this side. competency_public_read is
  // USING(true) (same policy listCompetencies above already reads through
  // unscoped), so this is a plain lookup, not a worker-scoped one.
  async hasActiveCompetency(citizenId: string, domainId: string): Promise<boolean> {
    const competency = await this.prisma.app.competency.findFirst({
      where: { citizenId, domainId, status: "active" },
    });
    return competency !== null;
  }

  // expert_assessment_public_read is USING(true) -- no citizen context
  // needed.
  async listAssessments(filter?: AssessmentListFilter): Promise<ExpertAssessment[]> {
    return this.prisma.app.expertAssessment.findMany({
      where: filter?.proposalId ? { proposalId: filter.proposalId } : undefined,
    });
  }

  // conflict_of_interest_public_read is USING(true) -- the same policy
  // publish()'s own coi.none check above already reads through unscoped.
  async listConflicts(filter?: ConflictListFilter): Promise<ConflictOfInterest[]> {
    return this.prisma.app.conflictOfInterest.findMany({
      where: {
        ...(filter?.citizenId ? { citizenId: filter.citizenId } : {}),
        ...(filter?.domainId ? { domainId: filter.domainId } : {}),
      },
    });
  }

  // competency_challenge_public_read is USING(true).
  async listChallenges(filter?: ChallengeListFilter): Promise<CompetencyChallenge[]> {
    return this.prisma.app.competencyChallenge.findMany({
      where: filter?.competencyId ? { competencyId: filter.competencyId } : undefined,
    });
  }

  // competency_own_insert's WITH CHECK is citizen_id = current_citizen_id()
  // -- forCitizen(citizenId, ...).
  private async applyForCompetency(input: ApplyForCompetencyInput): Promise<Competency> {
    try {
      return await this.prisma.forCitizen(input.citizenId, (tx) =>
        tx.competency.create({
          data: { citizenId: input.citizenId, domainId: input.domainId, level: input.level, evidenceRef: input.evidenceRef },
        }),
      );
    } catch (err) {
      // domain_id has a FOREIGN KEY to `expert_domain` -- a violation means
      // the referenced domain doesn't exist (convention: never let a raw
      // Prisma error escape to the controller).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("domain", input.domainId);
      }
      // E4-04/ADR-037: competency_citizen_domain_live_uidx -- one live
      // (applied|active) claim per (citizen, domain).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictDomainError(
          `Citizen ${input.citizenId} already has a live competency claim in domain ${input.domainId}`,
        );
      }
      throw err;
    }
  }

  // conflict_of_interest_own_insert's WITH CHECK is citizen_id =
  // current_citizen_id() -- forCitizen(citizenId, ...).
  private async declareConflictOfInterest(input: DeclareConflictOfInterestInput): Promise<ConflictOfInterest> {
    try {
      return await this.prisma.forCitizen(input.citizenId, (tx) =>
        tx.conflictOfInterest.create({
          data: {
            citizenId: input.citizenId,
            domainId: input.domainId,
            type: input.type,
            description: input.description,
          },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("domain", input.domainId);
      }
      throw err;
    }
  }

  // competency_challenge_own_insert's WITH CHECK is challenger_id =
  // current_citizen_id() -- forCitizen(challengerId, ...).
  private async submitCompetencyChallenge(input: SubmitCompetencyChallengeInput): Promise<CompetencyChallenge> {
    try {
      return await this.prisma.forCitizen(input.challengerId, (tx) =>
        tx.competencyChallenge.create({
          data: {
            competencyId: input.competencyId,
            challengerId: input.challengerId,
            evidenceRef: input.evidenceRef,
            reason: input.reason,
          },
        }),
      );
    } catch (err) {
      // competency_id has a FOREIGN KEY to `competency`.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("competency", input.competencyId);
      }
      throw err;
    }
  }

  // expert_assessment_domain_match_insert's WITH CHECK re-derives
  // domain:match + competency.active itself as a DB-layer backstop
  // (defense in depth) -- forCitizen(expertId, ...). AUTH-002's coi.none is
  // NOT enforced by this policy (schema-phase judgment call #3); publish()
  // above already checked it before calling this.
  private async publishAssessment(input: PublishAssessmentInput): Promise<ExpertAssessment> {
    try {
      return await this.prisma.forCitizen(input.expertId, (tx) =>
        tx.expertAssessment.create({
          data: {
            proposalId: input.proposalId,
            expertId: input.expertId,
            domainId: input.domainId,
            technicalScore: input.technicalScore,
            economicScore: input.economicScore,
            socialScore: input.socialScore,
            sustainabilityScore: input.sustainabilityScore,
            body: input.body,
          },
        }),
      );
    } catch (err) {
      // proposal_id has a FOREIGN KEY to `proposal` -- a violation means the
      // referenced proposal doesn't exist. A domain-match RLS violation (no
      // matching active competency) is a distinct, non-FK Postgres error and
      // is left to propagate as-is (publish()'s checks above are the
      // primary enforcement point; this is only the DB-layer backstop).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("proposal", input.proposalId);
      }
      throw err;
    }
  }
}
