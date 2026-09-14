import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ConflictDomainError, ForbiddenDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { GovernanceRoleChecker } from "./governance-role-checker.port.js";
import {
  Approval,
  ApprovalDecision,
  ApprovalType,
  GovernanceRole,
  GovernanceRoleListFilter,
  GovernanceRoleType,
  InsertApprovalInput,
} from "./governance-role.types.js";

const UNIQUE_VIOLATION = "P2002";

export interface SubmitApprovalInput {
  actionRef: string;
  approvalType: ApprovalType;
  decision: ApprovalDecision;
}

export interface ApprovalListFilter {
  actionRef?: string;
}

// DP-023, SRV-011: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
// governance_role rows are seeded/worker-managed (mirrors
// Jurisdiction/ExpertDomain/BudgetCategory) -- no citizen-facing create/
// update op exists here.
@Injectable()
export class GovernanceRoleService implements GovernanceRoleChecker {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // Public reference-data read -- governance_role rows are seeded/
  // worker-managed (mirrors jurisdiction/expert_domain/budget_category), no
  // citizen-facing create/update op exists.
  async listRoles(filter?: GovernanceRoleListFilter): Promise<GovernanceRole[]> {
    return this.findRoles(filter);
  }

  // GOVERNANCE_ROLE_CHECKER port (governance-role-checker.port.ts): the
  // exact predicate approval_own_role_insert's RLS EXISTS check enforces at
  // the DB layer -- true iff a governance_role row exists for this citizen
  // and roleType, with today within [term_start, term_end]. roleType is
  // cast to this module's internal enum at the boundary; an unrecognized
  // value (the port only promises one of TBL-032's six literal values)
  // simply never matches any row and resolves false.
  async isActiveHolder(citizenId: string, roleType: string): Promise<boolean> {
    const role = await this.findActiveRoleForCitizen(citizenId, roleType as GovernanceRoleType);
    return role !== null;
  }

  // DP-023: "Submit approval decision". AUTH-010's approval:submit:operator
  // / :council rows -- scope any, condition role.term (+ coi.none for
  // :council, a runtime business-rule check this pass can't resolve: no
  // domain reference exists anywhere in TBL-033/action_ref to check
  // conflict_of_interest against -- spec gap, documented rather than
  // invented, see governance-role.module.ts). The DTO layer
  // (SubmitApprovalDto) already restricts approvalType to
  // audit_confirmation | body_endorsement (FR-061).
  async submitApproval(citizenId: string, input: SubmitApprovalInput): Promise<Approval> {
    await assertActiveCitizen(this.citizenStatus, citizenId);

    // Judgment call: a citizen could theoretically hold more than one
    // simultaneous governance_role (SRV-011.md doesn't disambiguate this
    // edge case) -- the first currently-active one found is used as
    // "acting as this role". No role-selection UI/logic beyond that.
    const ownRole = await this.findActiveRoleForCitizen(citizenId);
    if (!ownRole) {
      throw new ForbiddenDomainError("Citizen holds no currently active governance role");
    }

    // SRV-011.md Key Rules: "A single person cannot supply multiple
    // approval types for the same action" -- per CITIZEN, not merely per
    // governance_role row (the @@unique([actionRef, approverRoleId]) DB
    // index only catches the same-role case). Cross-reference every
    // approval already recorded for this actionRef against every
    // governance_role this citizen has EVER held (findRoles({citizenId}),
    // not just the currently-active one) -- a citizen who already approved
    // via a role that has since expired must still be blocked from
    // approving again under a newly-assigned role.
    const [existingApprovals, myRoles] = await Promise.all([
      this.findApprovalsForAction(input.actionRef),
      this.findRoles({ citizenId }),
    ]);
    const myRoleIds = new Set(myRoles.map((role) => role.id));
    if (existingApprovals.some((approval) => myRoleIds.has(approval.approverRoleId))) {
      throw new ConflictDomainError(
        `Citizen ${citizenId} has already supplied an approval for action ${input.actionRef}`,
      );
    }

    const approval = await this.insertApproval(citizenId, {
      actionRef: input.actionRef,
      approverRoleId: ownRole.id,
      approvalType: input.approvalType,
      decision: input.decision,
    });

    // SRV-011.md Key Rules: "All role assignments, term expirations, and
    // approval decisions are emitted to audit-service" -- DP-023's own body
    // text doesn't say so directly, but the service doc does (same
    // "service-doc states it, DP-doc doesn't" shape as
    // DeliberationService.postArgument).
    await this.audit.emit({
      actionType: "governance_role.approval_submitted",
      actorRef: citizenId,
      payload: { approvalId: approval.id, actionRef: approval.actionRef, approvalType: approval.approvalType },
    });

    return approval;
  }

  // FR-007 ("every disabling action is logged with all approvers") / CON-005
  // transparency -- public read.
  async listApprovals(filter?: ApprovalListFilter): Promise<Approval[]> {
    return this.findApprovalsForAction(filter?.actionRef);
  }

  // governance_role_public_read is USING(true) for both roles -- no citizen
  // context needed, same as JurisdictionService.getTree's plain app read.
  // Shared by listRoles and submitApproval's per-citizen duplicate-approval
  // check.
  private async findRoles(filter?: GovernanceRoleListFilter): Promise<GovernanceRole[]> {
    return this.prisma.app.governanceRole.findMany({
      where: {
        ...(filter?.citizenId ? { citizenId: filter.citizenId } : {}),
        ...(filter?.roleType ? { roleType: filter.roleType } : {}),
      },
    });
  }

  // Public read, so no citizen context is needed even though the result is
  // scoped to one citizen -- the term-window comparison (the same predicate
  // approval_own_role_insert's RLS check applies) is pushed into SQL via
  // Prisma's lte/gte against `today`; DATE columns compare on the date
  // component only, so the time-of-day `new Date()` carries is irrelevant.
  // Shared by isActiveHolder and submitApproval's own-role resolution.
  private async findActiveRoleForCitizen(citizenId: string, roleType?: GovernanceRoleType): Promise<GovernanceRole | null> {
    const today = new Date();
    return this.prisma.app.governanceRole.findFirst({
      where: {
        citizenId,
        ...(roleType ? { roleType } : {}),
        termStart: { lte: today },
        termEnd: { gte: today },
      },
    });
  }

  // approval_public_read is USING(true) for both roles (FR-007 "every
  // disabling action is logged with all approvers" / CON-005 transparency).
  // Shared by submitApproval's duplicate check and listApprovals.
  private async findApprovalsForAction(actionRef?: string): Promise<Approval[]> {
    return this.prisma.app.approval.findMany({
      where: actionRef ? { actionRef } : undefined,
    });
  }

  // approval_own_role_insert's WITH CHECK is the ARCH-023 §4.1 EXISTS
  // variant against governance_role -- forCitizen(citizenId, ...) with the
  // service's already-verified role-holder id satisfies it.
  private async insertApproval(citizenId: string, input: InsertApprovalInput): Promise<Approval> {
    try {
      return await this.prisma.forCitizen(citizenId, (tx) =>
        tx.approval.create({
          data: {
            actionRef: input.actionRef,
            approverRoleId: input.approverRoleId,
            approvalType: input.approvalType,
            decision: input.decision,
          },
        }),
      );
    } catch (err) {
      // approval's @@unique([actionRef, approverRoleId]) -- the DB-level
      // backstop for "one row per role per action" (the stronger
      // per-CITIZEN rule is GovernanceRoleService.submitApproval's own
      // check, run before this is ever called).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
        throw new ConflictDomainError(`An approval already exists for action ${input.actionRef} from this role`);
      }
      throw err;
    }
  }
}
