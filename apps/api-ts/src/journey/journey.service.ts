import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import {
  ConflictDomainError,
  InvalidStateDomainError,
  NotFoundDomainError,
} from "../common/domain-errors.js";
import {
  JURISDICTION_MEMBERSHIP_CHECKER,
  type JurisdictionMembershipChecker,
} from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { ProposalService } from "../proposal/proposal.service.js";
import {
  VotingRuntime,
  type CertifiedSession,
  type VoteOption,
} from "./voting-runtime.js";

@Injectable()
export class JourneyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProposalService) private readonly proposals: ProposalService,
    @Inject(JURISDICTION_MEMBERSHIP_CHECKER)
    private readonly membership: JurisdictionMembershipChecker,
    @Inject(VotingRuntime) private readonly voting: VotingRuntime,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  async package(proposalId: string, citizenId?: string) {
    const proposal = await this.proposals.findById(proposalId);
    const [problem, budget, assessments, alternatives, projects] =
      await Promise.all([
        this.prisma.app.problem.findUnique({
          where: { id: proposal.problemId },
        }),
        this.proposals.getBudget(proposalId),
        this.prisma.app.expertAssessment.findMany({
          where: { proposalId },
          orderBy: { createdAt: "asc" },
        }),
        this.proposals.findAll({ problemId: proposal.problemId }),
        this.prisma.app.project.findMany({ where: { proposalId } }),
      ]);
    const missing: string[] = [];
    if (!proposal.scopeJurisdictionId)
      missing.push("Assign and review impact scope");
    if (proposal.scopeChallengedAt)
      missing.push("Resolve the open scope challenge");
    if (
      !proposal.objectives ||
      !proposal.measurableOutcomes ||
      !proposal.implementationTimeline
    )
      missing.push("Complete objectives, outcomes and implementation timeline");
    if (
      !budget ||
      [budget.cost, budget.maintenanceCost, budget.longTermCost].some(
        (v) => v === null,
      ) ||
      !budget.fundingSource ||
      !budget.expectedBenefits
    )
      missing.push("Complete funding and long-term impact information");
    if (!assessments.length) missing.push("Publish expert analysis");
    const eligible =
      citizenId && proposal.scopeJurisdictionId
        ? await this.membership.isEligible(
            citizenId,
            proposal.scopeJurisdictionId,
          )
        : citizenId
          ? false
          : null;
    return {
      proposal,
      problem,
      budget,
      expertAnalysis: assessments.map((a) => ({ ...a, assessment: a.body })),
      alternatives: alternatives.filter((p) => p.id !== proposalId),
      projects,
      eligible,
      missing,
      voting: {
        status: "unavailable",
        reason:
          "Voting is unavailable while the complete anonymous ballot protocol and independent verification remain unfinished.",
      },
    };
  }

  // A signed notification contains only a session ID. The decision is fetched
  // from the authoritative Go service; callers cannot submit their own tally.
  async reconcile(sessionId: string) {
    if (process.env.APP_ENV !== "development") {
      throw new ServiceUnavailableException(
        "Production governance completion requires reviewed ballot cryptography",
      );
    }
    const session = await this.voting.get<CertifiedSession>(
      `/voting/sessions/${sessionId}`,
    );
    const tally = session?.tally_result;
    if (
      session?.id !== sessionId ||
      session.status !== "certified" ||
      tally?.vote_session_id !== sessionId ||
      tally.decided !== true ||
      !tally.winner ||
      !Number.isSafeInteger(tally.total_ballots) ||
      tally.total_ballots <= 0
    ) {
      throw new InvalidStateDomainError(
        "A certified, decided, non-empty election is required",
      );
    }
    const result = await this.voting.get<{ options: VoteOption[] }>(
      `/voting/sessions/${sessionId}/options`,
    );
    if (!Array.isArray(result?.options))
      throw new InvalidStateDomainError("Election options are unavailable");
    const winner = result.options.find(
      (option) =>
        option.id === tally.winner && option.vote_session_id === sessionId,
    );
    if (!winner)
      throw new InvalidStateDomainError(
        "Certified winner is not a frozen election option",
      );
    const proposal = await this.proposals.findById(winner.proposal_id);
    const originating = await this.proposals.findById(session.proposal_id);
    if (
      proposal.problemId !== originating.problemId ||
      proposal.scopeJurisdictionId !== session.jurisdiction_id ||
      originating.scopeJurisdictionId !== session.jurisdiction_id
    )
      throw new InvalidStateDomainError(
        "Election scope does not match the proposal",
      );
    const budget = await this.proposals.getBudget(proposal.id);
    if (budget?.cost === null || budget?.cost === undefined)
      throw new InvalidStateDomainError(
        "Approved proposal needs an allocated budget",
      );
    const project = await this.prisma.forWorker(async (tx) => {
      // The row lock serializes concurrent notifications and lifecycle writes.
      await tx.$queryRaw`SELECT id FROM proposal WHERE id = ${proposal.id}::uuid FOR UPDATE`;
      const current = await tx.proposal.findUnique({
        where: { id: proposal.id },
      });
      if (!current) throw new NotFoundDomainError("proposal", proposal.id);
      if (!["voting", "approved"].includes(current.status))
        throw new InvalidStateDomainError(
          "Proposal is not awaiting a certified result",
        );
      const existing = await tx.project.findUnique({
        where: { proposalId: proposal.id },
      });
      if (existing && existing.certifiedVoteSessionId !== sessionId)
        throw new ConflictDomainError(
          "Project already has a different approval source",
        );
      if (existing) return existing;
      await tx.proposal.update({
        where: { id: proposal.id },
        data: { status: "approved" },
      });
      return tx.project.create({
        data: {
          proposalId: proposal.id,
          certifiedVoteSessionId: sessionId,
          budgetAllocated: budget.cost,
          status: "planned",
        },
      });
    });
    await this.audit.emit({
      actionType: "proposal.status_changed",
      actorRef: "governance-journey",
      payload: {
        proposalId: proposal.id,
        projectId: project.id,
        sessionId,
        status: "approved",
      },
    });
    return {
      ...project,
      budgetAllocated: project.budgetAllocated?.toNumber() ?? null,
      budgetSpent: project.budgetSpent?.toNumber() ?? null,
    };
  }
}
