import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { NotFoundDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  ArgumentListFilter,
  DeliberationArgument,
  DeliberationStance,
  Preference,
  PreferenceListFilter,
} from "./deliberation.types.js";

const FOREIGN_KEY_VIOLATION = "P2003";

// deliberation_argument has two nullable-target FKs an insert can violate
// (proposal_id, parent_id) -- unlike every other *_own_insert table in this
// app, which has only one referenced-row FK to disambiguate (problem_id on
// proposal, jurisdiction_id on problem). P2002/P2003 errors from the pg
// driver adapter (@prisma/adapter-pg, ADR-030) don't carry Prisma's classic
// `meta.field_name`; instead the violated constraint's name comes back at
// `meta.driverAdapterError.cause.constraint.index` (confirmed live against
// this app's dev Postgres, Prisma 7 + @prisma/adapter-pg) -- e.g.
// "deliberation_argument_parent_id_fkey" vs
// "deliberation_argument_proposal_id_fkey". author_id's FK is not
// disambiguated here: DeliberationService only ever calls this with an
// authorId already confirmed active by CITIZEN_STATUS_CHECKER, so that FK
// is unreachable in practice (same assumption ProposalService/ProblemService
// make for their own author_id/citizen_id columns).
function violatedConstraintName(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = err.meta as { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } } | undefined;
  const index = meta?.driverAdapterError?.cause?.constraint?.index;
  return typeof index === "string" ? index : undefined;
}

export interface PostArgumentInput {
  proposalId: string;
  parentId?: string;
  stance: DeliberationStance;
  body: string;
  evidenceRef: string;
}

export interface DeclarePreferenceInput {
  problemId: string;
  desiredOutcome: string;
}

// DP-008/DP-009, SRV-006: talks to Postgres directly via PrismaService's
// dual api_app/api_worker connections (ADR-030) -- no repository
// indirection.
@Injectable()
export class DeliberationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // DP-008: argument:post -- scope any, conditions citizen.active +
  // evidence.required (AUTH-010; evidenceRef non-empty is enforced at the
  // DTO layer via class-validator's @Length(1, ...)). Emits DP-036 --
  // DP-008.md's own body text doesn't say so, but SRV-006.md's Dependencies
  // section explicitly states "Emits to: ... audit-service (DP-036 on
  // argument post)".
  async postArgument(citizenId: string, input: PostArgumentInput): Promise<DeliberationArgument> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const argument = await this.insertArgument(citizenId, input);
    await this.audit.emit({
      actionType: "deliberation.argument_posted",
      actorRef: citizenId,
      payload: { argumentId: argument.id, proposalId: argument.proposalId },
    });
    return argument;
  }

  // DP-009: preference:declare -- scope any, condition citizen.active only
  // (AUTH-010). No audit emit -- neither DP-009.md nor SRV-006.md's
  // Dependencies section states one for this operation.
  async declarePreference(citizenId: string, input: DeclarePreferenceInput): Promise<Preference> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    return this.insertPreference(citizenId, input);
  }

  // FR-028: structured deliberation is public -- public read.
  // deliberation_argument_public_read is USING(true) for both roles -- no
  // citizen context needed.
  async listArguments(filter?: ArgumentListFilter): Promise<DeliberationArgument[]> {
    return this.prisma.app.deliberationArgument.findMany({
      where: filter?.proposalId ? { proposalId: filter.proposalId } : undefined,
    });
  }

  // FR-030: preferences feed proposal development -- public read.
  // preference_public_read is USING(true) for both roles.
  async listPreferences(filter?: PreferenceListFilter): Promise<Preference[]> {
    return this.prisma.app.preference.findMany({
      where: filter?.problemId ? { problemId: filter.problemId } : undefined,
    });
  }

  // deliberation_argument_own_insert's WITH CHECK is author_id =
  // current_citizen_id() -- forCitizen(authorId, ...); the SELECT policy is
  // public, so no RETURNING trick is needed (mirrors ProposalService's own
  // insert). A foreign-key violation on proposalId maps to
  // NotFoundDomainError("proposal", ...); on parentId (when provided) to
  // NotFoundDomainError("argument", ...).
  private async insertArgument(authorId: string, input: PostArgumentInput): Promise<DeliberationArgument> {
    try {
      return await this.prisma.forCitizen(authorId, (tx) =>
        tx.deliberationArgument.create({
          data: {
            proposalId: input.proposalId,
            authorId,
            parentId: input.parentId ?? null,
            stance: input.stance,
            body: input.body,
            evidenceRef: input.evidenceRef,
          },
        }),
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        const constraint = violatedConstraintName(err);
        if (constraint?.includes("parent_id") && input.parentId) {
          throw new NotFoundDomainError("argument", input.parentId);
        }
        throw new NotFoundDomainError("proposal", input.proposalId);
      }
      throw err;
    }
  }

  // preference_own_insert's WITH CHECK is citizen_id = current_citizen_id()
  // -- forCitizen(citizenId, ...). problem_id has a FOREIGN KEY to `problem`
  // -- a violation means the referenced problem doesn't exist (mirrors
  // ProblemService's jurisdictionId handling; only one FK to disambiguate
  // here), mapped to NotFoundDomainError("problem", ...).
  private async insertPreference(citizenId: string, input: DeclarePreferenceInput): Promise<Preference> {
    try {
      return await this.prisma.forCitizen(citizenId, (tx) =>
        tx.preference.create({
          data: {
            citizenId,
            problemId: input.problemId,
            desiredOutcome: input.desiredOutcome,
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
}
