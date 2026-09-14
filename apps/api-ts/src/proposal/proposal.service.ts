import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { JURISDICTION_MEMBERSHIP_CHECKER } from "../jurisdiction/jurisdiction-membership.port.js";
import type { JurisdictionMembershipChecker } from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ProposalSupportRecomputer } from "./proposal-support.port.js";
import { Proposal, ProposalBudget, ProposalConstraint, ProposalListFilter, ProposalStatus } from "./proposal.types.js";

// AUTH-010 proposal:constraint:add's condition list.
const CONSTRAINT_ADDABLE_STATUSES: readonly ProposalStatus[] = ["draft", "gathering_support", "development"];

const FOREIGN_KEY_VIOLATION = "P2003";

export interface CreateProposalInput {
  problemId: string;
  title: string;
  description: string;
  supportThreshold: number;
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
  ) {}

  // DP-005: proposal:create -- scope any, condition citizen.active. Emits
  // DP-036 (ADR-030's explicit list includes DP-005).
  async create(citizenId: string, input: CreateProposalInput): Promise<Proposal> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.insertProposal({
      problemId: input.problemId,
      authorId: citizenId,
      title: input.title,
      description: input.description,
      supportThreshold: input.supportThreshold,
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

  // DP-007: proposal:budget:add -- scope proposal:author, condition
  // citizen.active only (AUTH-010 lists no proposal.status gate here, unlike
  // constraint:add -- none added). No audit emit.
  async addBudget(citizenId: string, proposalId: string, input: AddBudgetInput): Promise<ProposalBudget> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.getProposalOrThrow(proposalId);
    this.assertAuthor(proposal, citizenId);
    return this.upsertBudget(citizenId, { proposalId, ...input });
  }

  // DP-020: scope_challenge:file -- scope jurisdiction:affected, condition
  // citizen.active. No audit emit.
  async fileScopeChallenge(citizenId: string, proposalId: string): Promise<Proposal> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const proposal = await this.getProposalOrThrow(proposalId);
    if (proposal.scopeJurisdictionId === null) {
      throw new InvalidStateDomainError(`Proposal ${proposalId} has no assigned scope jurisdiction to challenge`);
    }
    const affected = await this.jurisdictionMembership.isAffected(citizenId, proposal.scopeJurisdictionId);
    if (!affected) {
      throw new ForbiddenDomainError("Citizen is not affected by this proposal's scope jurisdiction");
    }
    return this.updateScopeChallenged(proposalId);
  }

  // PROPOSAL_SUPPORT_RECOMPUTER port (proposal-support.port.ts): DP-028,
  // called by ProblemModule (next phase) after a successful endorsement.
  // Pure recompute only -- no status transition (DP-029 out of scope,
  // ADR-030).
  async recomputeForProblem(problemId: string): Promise<void> {
    await this.recomputeSupportForProblem(problemId);
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

  // Worker-only write: no api_app UPDATE policy exists on `proposal` (only
  // proposal_own_insert + proposal_worker_all) -- see migration.sql's §6
  // comment for this table.
  private async updateScopeChallenged(proposalId: string): Promise<Proposal> {
    return this.prisma.forWorker((tx) =>
      tx.proposal.update({ where: { id: proposalId }, data: { scopeChallengedAt: new Date() } }),
    );
  }

  // DP-028, worker-only write (support_count is not author-writable).
  // problem_support lives in the (not-yet-built) problem module's table but
  // is readable here directly via Prisma -- same database/schema (ADR-027/028
  // precedent for direct cross-model reads within one app). Must be correct
  // for 0/1/many linked proposals and idempotent.
  private async recomputeSupportForProblem(problemId: string): Promise<void> {
    await this.prisma.forWorker(async (tx) => {
      const supportCount = await tx.problemSupport.count({ where: { problemId } });
      await tx.proposal.updateMany({ where: { problemId }, data: { supportCount } });
    });
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
