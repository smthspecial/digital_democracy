import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { BudgetLedger } from "../budget/budget-ledger.port.js";
import { BUDGET_LEDGER } from "../budget/budget-ledger.port.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ForbiddenDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { NOTIFICATION_EMITTER, type NotificationEmitter } from "../common/notification-emitter.js";
import { GOVERNANCE_ROLE_CHECKER } from "../governance-role/governance-role-checker.port.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { REPUTATION_RECORDER } from "../reputation/reputation-recorder.port.js";
import type { ReputationRecorder } from "../reputation/reputation-recorder.port.js";
import {
  InsertEvaluationInput,
  OutcomeEvaluation,
  OutcomeEvaluationListFilter,
  OutcomeEvaluationResult,
  Project,
  ProjectListFilter,
  ProjectMilestone,
  ProjectMilestoneListFilter,
  ProjectMilestoneStatus,
  ProjectProposalContext,
  UpdateMilestoneInput,
} from "./project.types.js";

const RECORD_NOT_FOUND = "P2025";
const FOREIGN_KEY_VIOLATION = "P2003";

// SRV-014.md doesn't define a magnitude for the successful_proposal delta a
// completed project's outcome evaluation feeds back to its original
// proposal's author -- a judgment call, mirroring
// reputation.service.ts's own SIGNIFICANT_DELTA_THRESHOLD.
const SUCCESSFUL_PROJECT_REPUTATION_DELTA = 5;

export interface ReportMilestoneInput {
  completedAt?: Date | null;
  status: ProjectMilestoneStatus;
  // SRV-013.md Key Rules ties budget_spent updates directly to DP-018
  // ("updated incrementally by project-service itself as spend is reported
  // (DP-018)") even though DP-018.md's own trigger text only mentions
  // completed_at/status -- a spend delta is accepted on the same call
  // rather than inventing a separate, unspecified endpoint.
  spentDelta?: number;
}

export interface SubmitEvaluationInput {
  objective: string;
  promisedOutcome: string;
  measuredOutcome: string;
  evaluation: OutcomeEvaluationResult;
}

// DP-018/DP-022, SRV-013: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
@Injectable()
export class ProjectService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_ROLE_CHECKER) private readonly governanceRole: GovernanceRoleChecker,
    @Inject(BUDGET_LEDGER) private readonly budgetLedger: BudgetLedger,
    @Inject(REPUTATION_RECORDER) private readonly reputation: ReputationRecorder,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
    @Inject(NOTIFICATION_EMITTER) private readonly notification: NotificationEmitter,
  ) {}

  // FR-046/047: public real-time oversight (ARCH-023 §6: project is PUBLIC).
  // project_public_read is USING(true) for both roles -- no citizen context
  // needed.
  async listProjects(filter?: ProjectListFilter): Promise<Project[]> {
    const rows = await this.prisma.app.project.findMany({ where: filter?.status ? { status: filter.status } : undefined });
    return rows.map(toProject);
  }

  async getProject(id: string): Promise<Project> {
    const row = await this.prisma.app.project.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundDomainError("project", id);
    }
    return toProject(row);
  }

  async listMilestones(filter?: ProjectMilestoneListFilter): Promise<ProjectMilestone[]> {
    const rows = await this.prisma.app.projectMilestone.findMany({
      where: filter?.projectId ? { projectId: filter.projectId } : undefined,
    });
    return rows.map(toProjectMilestone);
  }

  async listEvaluations(filter?: OutcomeEvaluationListFilter): Promise<OutcomeEvaluation[]> {
    const rows = await this.prisma.app.outcomeEvaluation.findMany({
      where: filter?.projectId ? { projectId: filter.projectId } : undefined,
    });
    return rows.map(toOutcomeEvaluation);
  }

  // DP-018. AUTH-009: "AUTH-005 or AUTH-006 | Within assigned project". The
  // "assigned to THIS project" half of that guard has no data-model support
  // anywhere (GovernanceRole carries no project reference) -- a spec gap,
  // documented rather than invented (mirrors GovernanceRoleService's own
  // undocumented-COI-domain gap for approval:submit:council). Only the
  // role-type half (active oversight or operator role) is checked, via
  // GOVERNANCE_ROLE_CHECKER since project_milestone's write is
  // api_worker-only (ARCH-023 §5's cross-service-scope pattern, resolved
  // in-process here since civic-duty-service now shares this app's database
  // -- but the assignment data simply doesn't exist for projects, unlike
  // civic_assignment).
  async reportMilestone(citizenId: string, milestoneId: string, input: ReportMilestoneInput): Promise<ProjectMilestone> {
    await this.assertOversightOrOperator(citizenId);

    const milestone = await this.prisma.app.projectMilestone.findUnique({ where: { id: milestoneId } });
    if (!milestone) {
      throw new NotFoundDomainError("project_milestone", milestoneId);
    }

    const updated = await this.updateMilestone(milestoneId, { completedAt: input.completedAt, status: input.status });

    // DP-018.md: "All updates are public and emitted to DP-036."
    await this.audit.emit({
      actionType: "project.milestone_reported",
      actorRef: citizenId,
      payload: { milestoneId: updated.id, projectId: updated.projectId, status: updated.status },
    });

    const needsContext = input.spentDelta !== undefined || updated.status === "delayed" || updated.status === "done";
    const context = needsContext ? await this.findProposalContextForProject(updated.projectId) : null;

    if (input.spentDelta !== undefined) {
      await this.incrementBudgetSpent(updated.projectId, input.spentDelta);

      // SRV-013.md: pushes a project-tagged ledger_entry outflow into
      // budget-service's public ledger. ledger_entry.jurisdictionId is
      // NOT NULL, but a proposal's scope_jurisdiction_id is nullable (not
      // every proposal has a scope set yet) -- documented gap: skip the
      // push rather than invent a jurisdiction id.
      if (context?.scopeJurisdictionId) {
        await this.budgetLedger.recordLedgerEntry({
          jurisdictionId: context.scopeJurisdictionId,
          projectId: updated.projectId,
          direction: "outflow",
          amount: input.spentDelta,
          source: `project ${updated.projectId} milestone ${updated.id} spend report`,
          occurredAt: new Date(),
        });
      }
    }

    // SRV-013.md Dependencies: "Emits to:... notification-service (DP-039:
    // milestone delays, completion)". Notified party (judgment call, spec
    // doesn't name one): the original proposal's author, the most directly
    // invested citizen.
    if (context && (updated.status === "delayed" || updated.status === "done")) {
      await this.notification.emit({
        eventType: updated.status === "delayed" ? "project.milestone_delayed" : "project.milestone_completed",
        citizenId: context.proposalAuthorId,
        payload: { milestoneId: updated.id, projectId: updated.projectId },
      });
    }

    return updated;
  }

  // DP-022. AUTH-009: "AUTH-003 or AUTH-005 | Active term" (auditor or
  // oversight) -- same "assigned"-scope data-model gap as reportMilestone.
  async submitEvaluation(citizenId: string, projectId: string, input: SubmitEvaluationInput): Promise<OutcomeEvaluation> {
    await this.assertAuditorOrOversight(citizenId);

    const project = await this.prisma.app.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundDomainError("project", projectId);
    }

    const created = await this.insertEvaluation({ projectId, ...input });

    // DP-022.md: "Emits DP-036."
    await this.audit.emit({
      actionType: "project.outcome_evaluation_submitted",
      actorRef: citizenId,
      payload: { evaluationId: created.id, projectId, evaluation: created.evaluation },
    });

    // DP-038 (reputation-service): "triggered by... project-service
    // (outcome success/failure)". Reputation's own DP-038 rule: "Negative
    // deltas require an upstream authoritative decision" -- an
    // 'unsuccessful'/'partial' outcome by itself isn't one (that needs a
    // fraud finding or similar), so only 'successful' feeds a positive
    // delta, onto the citizen who originally authored the proposal this
    // project implements.
    if (created.evaluation === "successful") {
      const context = await this.findProposalContextForProject(projectId);
      if (context) {
        await this.reputation.recordDelta({
          citizenId: context.proposalAuthorId,
          factorType: "successful_proposal",
          delta: SUCCESSFUL_PROJECT_REPUTATION_DELTA,
          reason: `Project ${projectId} outcome evaluation: successful`,
        });
      }
    }

    return created;
  }

  private async assertOversightOrOperator(citizenId: string): Promise<void> {
    const [oversight, operator] = await Promise.all([
      this.governanceRole.isActiveHolder(citizenId, "oversight"),
      this.governanceRole.isActiveHolder(citizenId, "operator"),
    ]);
    if (!oversight && !operator) {
      throw new ForbiddenDomainError("Reporting a milestone requires an active oversight or operator governance role");
    }
  }

  private async assertAuditorOrOversight(citizenId: string): Promise<void> {
    const [auditor, oversight] = await Promise.all([
      this.governanceRole.isActiveHolder(citizenId, "auditor"),
      this.governanceRole.isActiveHolder(citizenId, "oversight"),
    ]);
    if (!auditor && !oversight) {
      throw new ForbiddenDomainError(
        "Submitting an outcome evaluation requires an active auditor or oversight governance role",
      );
    }
  }

  // project_worker_update -- the `assigned`-scope role check already ran in
  // reportMilestone before this is called.
  private async incrementBudgetSpent(projectId: string, delta: number): Promise<Project> {
    try {
      const row = await this.prisma.forWorker((tx) =>
        tx.project.update({ where: { id: projectId }, data: { budgetSpent: { increment: delta } } }),
      );
      return toProject(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === RECORD_NOT_FOUND) {
        throw new NotFoundDomainError("project", projectId);
      }
      throw err;
    }
  }

  // Same-database join to proposal (public read on both sides) -- no
  // citizen context needed. Resolves the project's originating proposal's
  // author (DP-022's reputation trigger target) and scope_jurisdiction_id
  // (DP-018's ledger push target, nullable per proposal.types.ts).
  private async findProposalContextForProject(projectId: string): Promise<ProjectProposalContext | null> {
    const project = await this.prisma.app.project.findUnique({
      where: { id: projectId },
      include: { proposal: { select: { authorId: true, scopeJurisdictionId: true } } },
    });
    if (!project) {
      return null;
    }
    return { proposalAuthorId: project.proposal.authorId, scopeJurisdictionId: project.proposal.scopeJurisdictionId };
  }

  // project_milestone_worker_update -- same cross-service `assigned`-scope
  // reasoning as incrementBudgetSpent above.
  private async updateMilestone(id: string, input: UpdateMilestoneInput): Promise<ProjectMilestone> {
    try {
      const row = await this.prisma.forWorker((tx) =>
        tx.projectMilestone.update({
          where: { id },
          data: { status: input.status, ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}) },
        }),
      );
      return toProjectMilestone(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === RECORD_NOT_FOUND) {
        throw new NotFoundDomainError("project_milestone", id);
      }
      throw err;
    }
  }

  // outcome_evaluation_worker_insert -- no UPDATE policy on any role; an
  // evaluation is written once, not amended.
  private async insertEvaluation(input: InsertEvaluationInput): Promise<OutcomeEvaluation> {
    try {
      const row = await this.prisma.forWorker((tx) =>
        tx.outcomeEvaluation.create({
          data: {
            projectId: input.projectId,
            objective: input.objective,
            promisedOutcome: input.promisedOutcome,
            measuredOutcome: input.measuredOutcome,
            evaluation: input.evaluation,
          },
        }),
      );
      return toOutcomeEvaluation(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("project", input.projectId);
      }
      throw err;
    }
  }
}

function toProject(row: {
  id: string;
  proposalId: string;
  timelineStart: Date;
  timelineEnd: Date;
  budgetAllocated: Prisma.Decimal | null;
  budgetSpent: Prisma.Decimal | null;
  contractor: string;
  status: Project["status"];
}): Project {
  return {
    id: row.id,
    proposalId: row.proposalId,
    timelineStart: row.timelineStart,
    timelineEnd: row.timelineEnd,
    budgetAllocated: row.budgetAllocated === null ? null : row.budgetAllocated.toNumber(),
    budgetSpent: row.budgetSpent === null ? null : row.budgetSpent.toNumber(),
    contractor: row.contractor,
    status: row.status,
  };
}

function toProjectMilestone(row: {
  id: string;
  projectId: string;
  name: string;
  dueDate: Date;
  completedAt: Date | null;
  status: ProjectMilestone["status"];
}): ProjectMilestone {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    dueDate: row.dueDate,
    completedAt: row.completedAt,
    status: row.status,
  };
}

function toOutcomeEvaluation(row: {
  id: string;
  projectId: string;
  objective: string;
  promisedOutcome: string;
  measuredOutcome: string;
  evaluation: OutcomeEvaluation["evaluation"];
  evaluatedAt: Date;
}): OutcomeEvaluation {
  return {
    id: row.id,
    projectId: row.projectId,
    objective: row.objective,
    promisedOutcome: row.promisedOutcome,
    measuredOutcome: row.measuredOutcome,
    evaluation: row.evaluation,
    evaluatedAt: row.evaluatedAt,
  };
}
