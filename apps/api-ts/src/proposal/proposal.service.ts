import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { GOVERNANCE_ROLE_CHECKER } from "../governance-role/governance-role-checker.port.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { JURISDICTION_MEMBERSHIP_CHECKER } from "../jurisdiction/jurisdiction-membership.port.js";
import type { JurisdictionMembershipChecker } from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { CONSTITUTIONAL_REVIEWER, type ConstitutionalReviewer } from "./constitutional-reviewer.port.js";
import type { ProposalSupportRecomputer } from "./proposal-support.port.js";
import { Proposal, ProposalBudget, ProposalConstraint, ProposalListFilter, ProposalStatus, ScopeChallenge } from "./proposal.types.js";

// AUTH-010 proposal:constraint:add's condition list.
const CONSTRAINT_ADDABLE_STATUSES: readonly ProposalStatus[] = ["draft", "gathering_support", "development"];

// ADR-035 D16: the only author-triggered transitions. gathering_support ->
// development is system-triggered (maybeEnterDevelopment, below) -- an
// author cannot declare their own proposal has crossed the threshold.
const AUTHOR_TRIGGERED_TRANSITIONS: Partial<Record<ProposalStatus, ProposalStatus>> = {
  draft: "gathering_support",
  development: "voting",
};

const FOREIGN_KEY_VIOLATION = "P2003";

export interface CreateProposalInput {
  problemId: string;
  title: string;
  description: string;
}

// ADR-035 D14/D15, exported so it's independently unit-testable (no I/O).
// population null -> caller refuses (422), never a silent minThreshold
// fallback -- that decision belongs to the caller, this function just
// computes given a non-null population.
export function computeSupportThreshold(jurisdiction: {
  population: number;
  supportRateBps: number;
  minThreshold: number;
  maxThreshold: number | null;
}): number {
  const raw = Math.round((jurisdiction.population * jurisdiction.supportRateBps) / 10000);
  const floored = Math.max(raw, jurisdiction.minThreshold);
  return jurisdiction.maxThreshold === null ? floored : Math.min(floored, jurisdiction.maxThreshold);
}

export interface AddConstraintInput {
  text: string;
}

export interface AddBudgetInput {
  cost?: number;
  fundingSource?: string;
  fundingCategoryId?: string;
  maintenanceCost?: number;
  longTermCost?: number;
  expectedBenefits?: string;
}

// DP-005/006/007/020/028, SRV-004: talks to Postgres directly via
// PrismaService's dual api_app/api_worker connections (ADR-030) -- no
// repository indirection.
@Injectable()
export class ProposalService implements ProposalSupportRecomputer {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
    @Inject(JURISDICTION_MEMBERSHIP_CHECKER) private readonly jurisdictionMembership: JurisdictionMembershipChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
    @Inject(CONSTITUTIONAL_REVIEWER) private readonly constitutionalReviewer: ConstitutionalReviewer,
    @Inject(GOVERNANCE_ROLE_CHECKER) private readonly governanceRole: GovernanceRoleChecker,
  ) {}

  // DP-005: proposal:create -- scope any, condition citizen.active. Emits
  // DP-036 (ADR-030's explicit list includes DP-005).
  async create(citizenId: string, input: CreateProposalInput): Promise<Proposal> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const problem = await this.prisma.app.problem.findUnique({ where: { id: input.problemId } });
    if (!problem) {
      throw new NotFoundDomainError("problem", input.problemId);
    }
    const jurisdiction = await this.prisma.app.jurisdiction.findUnique({ where: { id: problem.jurisdictionId } });
    if (!jurisdiction || jurisdiction.population === null) {
      throw new InvalidStateDomainError(
        `Jurisdiction ${problem.jurisdictionId} has no recorded population; a support threshold cannot be computed`,
      );
    }
    const supportThreshold = computeSupportThreshold({
      population: jurisdiction.population,
      supportRateBps: jurisdiction.supportRateBps,
      minThreshold: jurisdiction.minThreshold,
      maxThreshold: jurisdiction.maxThreshold,
    });
    const proposal = await this.insertProposal({
      problemId: input.problemId,
      authorId: citizenId,
      title: input.title,
      description: input.description,
      supportThreshold,
    });
    await this.audit.emit({
      actionType: "proposal.created",
      actorRef: citizenId,
      payload: { proposalId: proposal.id, problemId: proposal.problemId },
    });
    return proposal;
  }

  // DP-006: proposal:constraint:add -- scope proposal:author, conditions
  // citizen.active + proposal.status:draft,gathering_support,development.
  // No audit emit (DP-006's doc text doesn't say "Emits DP-036").
  async addConstraint(citizenId: string, proposalId: string, input: AddConstraintInput): Promise<ProposalConstraint> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.getProposalOrThrow(proposalId);
    this.assertAuthor(proposal, citizenId);
    if (!CONSTRAINT_ADDABLE_STATUSES.includes(proposal.status)) {
      throw new InvalidStateDomainError(
        `Constraints can only be added while the proposal is draft, gathering_support, or development; proposal ${proposalId} is ${proposal.status}`,
      );
    }
    return this.insertConstraint(citizenId, { proposalId, text: input.text });
  }

  // DP-007: proposal:budget:add -- scope proposal:author. E3-12: gated to
  // the same addable-statuses window as addConstraint -- AUTH-010 lists no
  // explicit proposal.status condition here, but the audit found this
  // callable on an archived proposal, which US-013's "development phase
  // accepts cost estimates" doesn't intend. No audit emit.
  async addBudget(citizenId: string, proposalId: string, input: AddBudgetInput): Promise<ProposalBudget> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.getProposalOrThrow(proposalId);
    this.assertAuthor(proposal, citizenId);
    if (!CONSTRAINT_ADDABLE_STATUSES.includes(proposal.status)) {
      throw new InvalidStateDomainError(
        `Budget info can only be added while the proposal is draft, gathering_support, or development; proposal ${proposalId} is ${proposal.status}`,
      );
    }
    return this.upsertBudget(citizenId, { proposalId, ...input });
  }

  // proposal_constraint_public_read is USING(true) -- "Constraint sets are
  // public" (EPIC-005), no citizen context needed.
  async listConstraints(proposalId: string): Promise<ProposalConstraint[]> {
    return this.prisma.app.proposalConstraint.findMany({ where: { proposalId } });
  }

  // proposal_budget_public_read is USING(true) -- "voters see complete
  // funding information" (EPIC-006/US-028). One row per proposal (upsert
  // keyed on proposalId); null until an author has ever called addBudget.
  async getBudget(proposalId: string): Promise<ProposalBudget | null> {
    const row = await this.prisma.app.proposalBudget.findUnique({ where: { proposalId } });
    return row ? toProposalBudget(row) : null;
  }

  // DP-020: scope_challenge:file -- scope jurisdiction:affected, condition
  // citizen.active. ADR-038: a first-class ScopeChallenge row (status +
  // resolution), not just the legacy scopeChallengedAt timestamp -- both are
  // kept in sync (E2-09's voting-entry gate reads scopeChallengedAt as the
  // cheap "is anything open" check).
  async fileScopeChallenge(citizenId: string, proposalId: string, reason: string): Promise<Proposal> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.getProposalOrThrow(proposalId);
    if (proposal.scopeJurisdictionId === null) {
      throw new InvalidStateDomainError(`Proposal ${proposalId} has no assigned scope jurisdiction to challenge`);
    }
    const affected = await this.jurisdictionMembership.isAffected(citizenId, proposal.scopeJurisdictionId);
    if (!affected) {
      throw new ForbiddenDomainError("Citizen is not affected by this proposal's scope jurisdiction");
    }
    return this.prisma.forWorker(async (tx) => {
      await tx.scopeChallenge.create({ data: { proposalId, challengerId: citizenId, reason } });
      return tx.proposal.update({ where: { id: proposalId }, data: { scopeChallengedAt: new Date() } });
    });
  }

  async listScopeChallenges(proposalId: string): Promise<ScopeChallenge[]> {
    return this.prisma.app.scopeChallenge.findMany({ where: { proposalId }, orderBy: { createdAt: "desc" } });
  }

  // ADR-038 D10: gated on an active review_body role. E2-05.
  async assignScope(reviewerId: string, proposalId: string, jurisdictionId: string, rationale: string): Promise<Proposal> {
    const isReviewBody = await this.governanceRole.isActiveHolder(reviewerId, "review_body");
    if (!isReviewBody) {
      throw new ForbiddenDomainError("Only an active review_body role holder may assign a proposal's scope");
    }
    await this.getProposalOrThrow(proposalId);
    const updated = await this.prisma.forWorker((tx) =>
      tx.proposal.update({ where: { id: proposalId }, data: { scopeJurisdictionId: jurisdictionId, scopeRationale: rationale } }),
    );
    await this.audit.emit({
      actionType: "proposal.status_changed",
      actorRef: reviewerId,
      payload: { proposalId, event: "scope_assigned", jurisdictionId },
    });
    return updated;
  }

  // ADR-038 D10/E2-08: independent review-body resolution -- public
  // (resolution + resolvedAt), never the challenger or the proposal author.
  async resolveScopeChallenge(reviewerId: string, challengeId: string, outcome: "upheld" | "dismissed", resolution: string): Promise<ScopeChallenge> {
    const isReviewBody = await this.governanceRole.isActiveHolder(reviewerId, "review_body");
    if (!isReviewBody) {
      throw new ForbiddenDomainError("Only an active review_body role holder may resolve a scope challenge");
    }
    const challenge = await this.prisma.app.scopeChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge) {
      throw new NotFoundDomainError("scopeChallenge", challengeId);
    }
    if (challenge.status !== "open") {
      throw new InvalidStateDomainError(`Scope challenge ${challengeId} is already ${challenge.status}`);
    }
    return this.prisma.forWorker(async (tx) => {
      const updated = await tx.scopeChallenge.update({
        where: { id: challengeId },
        data: { status: outcome, resolution, resolvedAt: new Date() },
      });
      const stillOpen = await tx.scopeChallenge.count({ where: { proposalId: challenge.proposalId, status: "open" } });
      if (stillOpen === 0) {
        await tx.proposal.update({ where: { id: challenge.proposalId }, data: { scopeChallengedAt: null } });
      }
      return updated;
    });
  }

  // PROPOSAL_SUPPORT_RECOMPUTER port (proposal-support.port.ts): DP-028,
  // called by ProblemModule after a successful endorsement. Recomputes
  // support_count, then checks every affected proposal for the
  // gathering_support -> development threshold crossing (DP-029,
  // ADR-035 D16 -- system-triggered, not author-triggered).
  async recomputeForProblem(problemId: string): Promise<void> {
    await this.recomputeSupportForProblem(problemId);
  }

  // DP-029/ADR-035: the one shared domain function for every proposal
  // status transition an author can request -- the gate cannot be bypassed
  // by calling a narrower method, because there isn't one.
  //   draft -> gathering_support: always allowed (the author publishing a
  //     draft is theirs to decide).
  //   development -> voting: gated by ConstitutionalReviewer, fail-closed
  //     (ADR-035 D20/ADR-038 D11) -- also where EPIC-002's scope-assigned +
  //     no-pending-challenge gate attaches once E2-09 lands.
  //   gathering_support -> development: system-only (maybeEnterDevelopment),
  //     rejected here with InvalidStateDomainError.
  // Emits proposal_status_changed (TBL-034) -- an exact enum match, no
  // verb-mapping needed.
  async advance(citizenId: string, proposalId: string): Promise<Proposal> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.getProposalOrThrow(proposalId);
    this.assertAuthor(proposal, citizenId);

    // ADR-036/E5-15: deadlock-blocks-normal-lifecycle -- while a proposal
    // is in the deadlock track, only DeadlockService.conclude() may change
    // its status.
    if (proposal.deadlockActive) {
      throw new InvalidStateDomainError(`Proposal ${proposalId} is in the deadlock track; normal advance() is blocked`);
    }

    const next = AUTHOR_TRIGGERED_TRANSITIONS[proposal.status];
    if (!next) {
      throw new InvalidStateDomainError(
        `Proposal ${proposalId} cannot be advanced from ${proposal.status} by its author`,
      );
    }

    if (proposal.status === "development") {
      // ADR-038 D11/E2-09: the voting-entry gate. Every condition must
      // hold -- scope assigned, no open challenge, constitutional review
      // cleared -- or the transition is blocked. This is what closes the
      // audit's "voting-entry gate is vacuous" finding: previously nothing
      // enforced any of these three at this exact point.
      if (proposal.scopeJurisdictionId === null) {
        throw new InvalidStateDomainError(`Proposal ${proposalId} has no assigned scope; development -> voting is blocked`);
      }
      if (proposal.scopeChallengedAt !== null) {
        throw new InvalidStateDomainError(`Proposal ${proposalId} has an open scope challenge; development -> voting is blocked`);
      }
      const cleared = await this.constitutionalReviewer.isCleared(proposalId);
      if (!cleared) {
        throw new InvalidStateDomainError(
          `Proposal ${proposalId} has not cleared constitutional review; development -> voting is blocked`,
        );
      }
    }

    return this.transitionStatus(proposalId, next, citizenId);
  }

  async findById(id: string): Promise<Proposal> {
    return this.getProposalOrThrow(id);
  }

  // FR-018: competing proposals on the same problem, presented side by side.
  // proposal_public_read is USING(true) for both roles -- no citizen context
  // needed.
  async findAll(filter?: ProposalListFilter): Promise<Proposal[]> {
    return this.prisma.app.proposal.findMany({
      where: filter?.problemId ? { problemId: filter.problemId } : undefined,
    });
  }

  // proposal_public_read is USING(true) for both roles -- no citizen context
  // needed (mirrors JurisdictionService.getTree).
  private async getProposalOrThrow(proposalId: string): Promise<Proposal> {
    const proposal = await this.prisma.app.proposal.findUnique({ where: { id: proposalId } });
    if (!proposal) {
      throw new NotFoundDomainError("proposal", proposalId);
    }
    return proposal;
  }

  private assertAuthor(proposal: Proposal, citizenId: string): void {
    if (proposal.authorId !== citizenId) {
      throw new ForbiddenDomainError("Only the proposal's author may perform this action");
    }
  }

  // proposal_own_insert's WITH CHECK is author_id = current_citizen_id() --
  // authorId travels on `input` itself (there is no pre-existing row to
  // scope a separate forCitizen call against, unlike insertConstraint/
  // upsertBudget below); the SELECT policy is public, so no RETURNING trick
  // is needed here (unlike identity's registerCitizen). A foreign-key
  // violation on problemId means the referenced problem doesn't exist
  // (convention: never let a raw Prisma error escape to the controller).
  private async insertProposal(input: {
    problemId: string;
    authorId: string;
    title: string;
    description: string;
    supportThreshold: number;
  }): Promise<Proposal> {
    try {
      return await this.prisma.forCitizen(input.authorId, (tx) =>
        tx.proposal.create({
          data: {
            problemId: input.problemId,
            authorId: input.authorId,
            title: input.title,
            description: input.description,
            supportThreshold: input.supportThreshold,
          },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("problem", input.problemId);
      }
      throw err;
    }
  }

  // proposal_constraint_own_insert's WITH CHECK is an EXISTS against the
  // parent proposal's author_id -- authorId is the service's already-
  // verified proposal author, used only to set the RLS context (forCitizen(
  // authorId, ...) satisfies the EXISTS), never written onto the constraint
  // row itself.
  private async insertConstraint(authorId: string, input: { proposalId: string; text: string }): Promise<ProposalConstraint> {
    return this.prisma.forCitizen(authorId, (tx) =>
      tx.proposalConstraint.create({ data: { proposalId: input.proposalId, text: input.text } }),
    );
  }

  // Same EXISTS-on-parent shape as insertConstraint (proposal_budget_own_insert
  // / proposal_budget_own_update); create-or-update keyed on the unique
  // proposalId (DP-007).
  private async upsertBudget(
    authorId: string,
    input: {
      proposalId: string;
      cost?: number;
      fundingSource?: string;
      fundingCategoryId?: string;
      maintenanceCost?: number;
      longTermCost?: number;
      expectedBenefits?: string;
    },
  ): Promise<ProposalBudget> {
    const row = await this.prisma.forCitizen(authorId, (tx) =>
      tx.proposalBudget.upsert({
        where: { proposalId: input.proposalId },
        create: {
          proposalId: input.proposalId,
          cost: input.cost,
          fundingSource: input.fundingSource,
          fundingCategoryId: input.fundingCategoryId,
          maintenanceCost: input.maintenanceCost,
          longTermCost: input.longTermCost,
          expectedBenefits: input.expectedBenefits,
        },
        update: {
          ...(input.cost !== undefined ? { cost: input.cost } : {}),
          ...(input.fundingSource !== undefined ? { fundingSource: input.fundingSource } : {}),
          ...(input.fundingCategoryId !== undefined ? { fundingCategoryId: input.fundingCategoryId } : {}),
          ...(input.maintenanceCost !== undefined ? { maintenanceCost: input.maintenanceCost } : {}),
          ...(input.longTermCost !== undefined ? { longTermCost: input.longTermCost } : {}),
          ...(input.expectedBenefits !== undefined ? { expectedBenefits: input.expectedBenefits } : {}),
        },
      }),
    );
    return toProposalBudget(row);
  }

  // DP-028, worker-only write (support_count is not author-writable).
  // problem_support lives in the (not-yet-built) problem module's table but
  // is readable here directly via Prisma -- same database/schema (ADR-027/028
  // precedent for direct cross-model reads within one app). Must be correct
  // for 0/1/many linked proposals and idempotent. Every proposal linked to
  // this problem shares problemSupport's count today (E3-11 replaces this
  // with per-proposal support so competing proposals can be discriminated
  // -- ADR-035 D17 -- this method's shape doesn't change, only the source
  // count does).
  private async recomputeSupportForProblem(problemId: string): Promise<void> {
    const supportCount = await this.prisma.forWorker((tx) => tx.problemSupport.count({ where: { problemId } }));
    const proposals = await this.prisma.forWorker((tx) =>
      tx.proposal.findMany({ where: { problemId }, select: { id: true, status: true, supportThreshold: true } }),
    );
    await this.prisma.forWorker((tx) => tx.proposal.updateMany({ where: { problemId }, data: { supportCount } }));
    for (const p of proposals) {
      if (p.status === "gathering_support" && supportCount >= p.supportThreshold) {
        await this.transitionStatus(p.id, "development", "system");
      }
    }
  }

  // The one place any proposal.status write happens -- both advance() and
  // the auto-transition above go through this, so the audit trail and
  // worker-only-write property (no api_app UPDATE policy on proposal) hold
  // for every transition, not just author-triggered ones.
  private async transitionStatus(proposalId: string, status: ProposalStatus, actorRef: string): Promise<Proposal> {
    const updated = await this.prisma.forWorker((tx) => tx.proposal.update({ where: { id: proposalId }, data: { status } }));
    await this.audit.emit({
      actionType: "proposal.status_changed",
      actorRef,
      payload: { proposalId, status },
    });
    return updated;
  }
}

function toProposalBudget(row: {
  id: string;
  proposalId: string;
  cost: Prisma.Decimal | null;
  fundingSource: string | null;
  fundingCategoryId: string | null;
  maintenanceCost: Prisma.Decimal | null;
  longTermCost: Prisma.Decimal | null;
  expectedBenefits: string | null;
}): ProposalBudget {
  return {
    id: row.id,
    proposalId: row.proposalId,
    cost: row.cost === null ? null : row.cost.toNumber(),
    fundingSource: row.fundingSource,
    fundingCategoryId: row.fundingCategoryId,
    maintenanceCost: row.maintenanceCost === null ? null : row.maintenanceCost.toNumber(),
    longTermCost: row.longTermCost === null ? null : row.longTermCost.toNumber(),
    expectedBenefits: row.expectedBenefits,
  };
}
