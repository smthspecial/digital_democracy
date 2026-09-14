import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ConflictDomainError, ForbiddenDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { JURISDICTION_MEMBERSHIP_CHECKER } from "../jurisdiction/jurisdiction-membership.port.js";
import type { JurisdictionMembershipChecker } from "../jurisdiction/jurisdiction-membership.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { PROPOSAL_SUPPORT_RECOMPUTER } from "../proposal/proposal-support.port.js";
import type { ProposalSupportRecomputer } from "../proposal/proposal-support.port.js";
import { AddSupportInput, CreateProblemInput, Problem, ProblemSupport } from "./problem.types.js";

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";

export interface SubmitProblemInput {
  title: string;
  description: string;
  affectedArea: string;
  jurisdictionId: string;
}

export interface EndorseProblemResult {
  problem: Problem;
  support: ProblemSupport;
}

// DP-003/004, SRV-003: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
@Injectable()
export class ProblemService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
    @Inject(JURISDICTION_MEMBERSHIP_CHECKER) private readonly jurisdictionMembership: JurisdictionMembershipChecker,
    @Inject(PROPOSAL_SUPPORT_RECOMPUTER) private readonly proposalSupport: ProposalSupportRecomputer,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // DP-003: problem:create -- scope any, condition citizen.active (AUTH-010).
  // Emits DP-036 (ADR-030's explicit list includes DP-003).
  async submit(citizenId: string, input: SubmitProblemInput): Promise<Problem> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const problem = await this.createProblem({
      authorId: citizenId,
      title: input.title,
      description: input.description,
      affectedArea: input.affectedArea,
      jurisdictionId: input.jurisdictionId,
    });
    await this.audit.emit({
      actionType: "problem.created",
      actorRef: citizenId,
      payload: { problemId: problem.id },
    });
    return problem;
  }

  // DP-004: problem:endorse -- scope jurisdiction:member, conditions
  // citizen.active + unique:(citizen,problem) (AUTH-010). No audit emit
  // (DP-004's doc text doesn't say "Emits DP-036", ADR-030's explicit list
  // omits it). On success triggers DP-028 in-process.
  async endorse(citizenId: string, problemId: string): Promise<EndorseProblemResult> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const problem = await this.getProblemOrThrow(problemId);

    const isMember = await this.jurisdictionMembership.isMember(citizenId, problem.jurisdictionId);
    if (!isMember) {
      throw new ForbiddenDomainError("Citizen is not a member of this problem's jurisdiction");
    }

    // Pre-insert duplicate check for AUTH-010's unique:(citizen,problem)
    // condition on problem:endorse (DP-004). problem_support_public_read is
    // likewise USING(true) -- the pre-insert duplicate check needs no
    // citizen context either. Proactive check; the DB unique index
    // (enforced in addSupport below) is the backstop, not the primary
    // mechanism -- mirrors identity's registerCitizen pattern exactly.
    const existing = await this.prisma.app.problemSupport.findFirst({ where: { problemId, citizenId } });
    if (existing) {
      throw new ConflictDomainError("Citizen has already endorsed this problem");
    }

    const support = await this.addSupport({ problemId, citizenId });
    // DP-028, triggered synchronously in-process (no queue exists on the TS
    // side yet -- ADR-030).
    await this.proposalSupport.recomputeForProblem(problemId);
    return { problem, support };
  }

  async findById(id: string): Promise<Problem> {
    return this.getProblemOrThrow(id);
  }

  // FR-016: submitted problems are public immediately (problem_public_read
  // is USING(true) for both roles -- no citizen context needed).
  async findAll(): Promise<Problem[]> {
    return this.prisma.app.problem.findMany();
  }

  // problem_public_read is USING(true) for both roles -- no citizen context
  // needed, same as ProposalService's own findById/findAll reads.
  private async getProblemOrThrow(problemId: string): Promise<Problem> {
    const problem = await this.prisma.app.problem.findUnique({ where: { id: problemId } });
    if (!problem) {
      throw new NotFoundDomainError("problem", problemId);
    }
    return problem;
  }

  // problem_own_insert's WITH CHECK is author_id = current_citizen_id() --
  // authorId travels on `input` itself (DP-003). The SELECT policy is
  // public, so no RETURNING trick is needed here (unlike identity's
  // registerCitizen; same shape as ProposalService's own insertProposal).
  private async createProblem(input: CreateProblemInput): Promise<Problem> {
    try {
      return await this.prisma.forCitizen(input.authorId, (tx) =>
        tx.problem.create({
          data: {
            authorId: input.authorId,
            title: input.title,
            description: input.description,
            affectedArea: input.affectedArea,
            jurisdictionId: input.jurisdictionId,
          },
        }),
      );
    } catch (err) {
      // jurisdiction_id has a FOREIGN KEY to `jurisdiction` -- a violation
      // means the referenced jurisdiction doesn't exist (convention: never
      // let a raw Prisma error escape to the controller).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("jurisdiction", input.jurisdictionId);
      }
      throw err;
    }
  }

  // problem_support_own_insert's WITH CHECK is citizen_id =
  // current_citizen_id().
  private async addSupport(input: AddSupportInput): Promise<ProblemSupport> {
    try {
      return await this.prisma.forCitizen(input.citizenId, (tx) =>
        tx.problemSupport.create({ data: { problemId: input.problemId, citizenId: input.citizenId } }),
      );
    } catch (err) {
      // A unique-constraint violation (P2002) on (problem_id, citizen_id)
      // maps to ConflictDomainError -- defense-in-depth backstop behind the
      // pre-check in endorse() above (catches a race the pre-check can miss
      // under concurrency), mirroring identity.repository.prisma.ts's
      // UNIQUE_VIOLATION handling.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictDomainError("Citizen has already endorsed this problem");
      }
      throw err;
    }
  }
}
