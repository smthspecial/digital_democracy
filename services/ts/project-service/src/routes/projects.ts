import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import type {
  Project,
  ProjectMilestone,
  OutcomeEvaluation,
} from "../domain/types.js";
import {
  createProject,
  getProject,
  listProjects,
  listMilestones,
  completeMilestone,
  recordBudgetSpent,
  sweepOutcomeEvaluations,
  submitOutcomeEvaluation,
} from "../services/projects.js";

function toProjectDto(project: Project) {
  return {
    id: project.id,
    proposal_id: project.proposalId,
    contractor: project.contractor,
    budget_allocated: project.budgetAllocated,
    budget_spent: project.budgetSpent,
    status: project.status,
    created_at: project.createdAt.toISOString(),
    completed_at: project.completedAt ? project.completedAt.toISOString() : null,
  };
}

function toMilestoneDto(milestone: ProjectMilestone) {
  return {
    id: milestone.id,
    project_id: milestone.projectId,
    title: milestone.title,
    due_date: milestone.dueDate,
    order_index: milestone.orderIndex,
    status: milestone.status,
    completed_at: milestone.completedAt
      ? milestone.completedAt.toISOString()
      : null,
  };
}

function toOutcomeEvaluationDto(evaluation: OutcomeEvaluation) {
  return {
    id: evaluation.id,
    project_id: evaluation.projectId,
    objective: evaluation.objective,
    promised_outcome: evaluation.promisedOutcome,
    measured_outcome: evaluation.measuredOutcome,
    evaluation: evaluation.evaluation,
    evaluated_at: evaluation.evaluatedAt
      ? evaluation.evaluatedAt.toISOString()
      : null,
  };
}

interface CreateProjectBody {
  proposal_id: string;
  contractor: string;
  budget_allocated: number;
  objective: string;
  promised_outcome: string;
  milestones: { title: string; due_date: string; order_index: number }[];
}

const createProjectSchema = {
  body: {
    type: "object",
    required: [
      "proposal_id",
      "contractor",
      "budget_allocated",
      "objective",
      "promised_outcome",
      "milestones",
    ],
    additionalProperties: false,
    properties: {
      proposal_id: { type: "string", minLength: 1 },
      contractor: { type: "string", minLength: 1 },
      budget_allocated: { type: "number", minimum: 0 },
      objective: { type: "string", minLength: 1 },
      promised_outcome: { type: "string", minLength: 1 },
      milestones: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "due_date", "order_index"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1 },
            due_date: { type: "string", minLength: 1 },
            order_index: { type: "integer", minimum: 0 },
          },
        },
      },
    },
  },
};

interface BudgetSpentBody {
  amount: number;
  description: string;
}

const budgetSpentSchema = {
  body: {
    type: "object",
    required: ["amount", "description"],
    additionalProperties: false,
    properties: {
      amount: { type: "number", exclusiveMinimum: 0 },
      description: { type: "string", minLength: 1 },
    },
  },
};

interface SweepBody {
  now?: string;
  evaluation_delay_days?: number;
}

const sweepSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      now: { type: "string", minLength: 1 },
      evaluation_delay_days: { type: "integer", minimum: 0 },
    },
  },
};

interface SubmitEvaluationBody {
  measured_outcome: string;
  evaluation: "successful" | "partial" | "unsuccessful";
}

const submitEvaluationSchema = {
  body: {
    type: "object",
    required: ["measured_outcome", "evaluation"],
    additionalProperties: false,
    properties: {
      measured_outcome: { type: "string", minLength: 1 },
      evaluation: {
        type: "string",
        enum: ["successful", "partial", "unsuccessful"],
      },
    },
  },
};

export function registerProjectRoutes(app: FastifyInstance, deps: Deps): void {
  const { store, auditEmitter, assignmentRequester, ledgerRecorder, proposalAuthorLookup, reputationEmitter } = deps;

  app.post<{ Body: CreateProjectBody }>(
    "/",
    { schema: createProjectSchema },
    async (request, reply) => {
      const body = request.body;
      const result = createProject(store, {
        proposalId: body.proposal_id,
        contractor: body.contractor,
        budgetAllocated: body.budget_allocated,
        objective: body.objective,
        promisedOutcome: body.promised_outcome,
        milestones: body.milestones.map((m) => ({
          title: m.title,
          dueDate: m.due_date,
          orderIndex: m.order_index,
        })),
      });
      reply.code(201);
      return {
        ...toProjectDto(result.project),
        milestones: result.milestones.map(toMilestoneDto),
        outcome_evaluation: toOutcomeEvaluationDto(result.outcomeEvaluation),
      };
    },
  );

  app.get("/", async () => listProjects(store).map(toProjectDto));

  app.get<{ Params: { id: string } }>("/:id", async (request) => {
    return toProjectDto(getProject(store, request.params.id));
  });

  app.get<{ Params: { id: string } }>("/:id/milestones", async (request) => {
    return listMilestones(store, request.params.id).map(toMilestoneDto);
  });

  app.post<{ Params: { id: string; milestoneId: string } }>(
    "/:id/milestones/:milestoneId/complete",
    async (request) => {
      const { project, milestone } = completeMilestone(
        store,
        auditEmitter,
        request.params.id,
        request.params.milestoneId,
      );
      return {
        project: toProjectDto(project),
        milestone: toMilestoneDto(milestone),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: BudgetSpentBody }>(
    "/:id/budget-spent",
    { schema: budgetSpentSchema },
    async (request) => {
      const project = recordBudgetSpent(
        store,
        ledgerRecorder,
        request.params.id,
        request.body.amount,
        request.body.description,
      );
      return toProjectDto(project);
    },
  );

  app.post<{ Body: SweepBody }>(
    "/outcome-evaluations/sweep",
    { schema: sweepSchema },
    async (request) => {
      const requestedProjectIds = sweepOutcomeEvaluations(
        store,
        assignmentRequester,
        {
          now: request.body.now ? new Date(request.body.now) : undefined,
          evaluationDelayDays: request.body.evaluation_delay_days,
        },
      );
      return { requested_project_ids: requestedProjectIds };
    },
  );

  app.post<{ Params: { id: string }; Body: SubmitEvaluationBody }>(
    "/outcome-evaluations/:id/submit",
    { schema: submitEvaluationSchema },
    async (request) => {
      const evaluation = await submitOutcomeEvaluation(
        store,
        reputationEmitter,
        proposalAuthorLookup,
        request.params.id,
        {
          measuredOutcome: request.body.measured_outcome,
          evaluation: request.body.evaluation,
        },
      );
      return toOutcomeEvaluationDto(evaluation);
    },
  );
}
