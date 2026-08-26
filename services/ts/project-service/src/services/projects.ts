import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { AuditEmitter, AssignmentRequester } from "../integrations.js";
import { notFound, conflict } from "../errors.js";
import type {
  Project,
  ProjectMilestone,
  OutcomeEvaluation,
} from "../domain/types.js";

export const DEFAULT_EVALUATION_DELAY_DAYS = 180;

export interface CreateProjectMilestoneInput {
  title: string;
  dueDate: string;
  orderIndex: number;
}

export interface CreateProjectInput {
  proposalId: string;
  contractor: string;
  budgetAllocated: number;
  promisedOutcome: string;
  milestones: CreateProjectMilestoneInput[];
}

export interface CreateProjectResult {
  project: Project;
  milestones: ProjectMilestone[];
  outcomeEvaluation: OutcomeEvaluation;
}

export function createProject(
  store: Store,
  input: CreateProjectInput,
): CreateProjectResult {
  const now = new Date();

  const project: Project = {
    id: randomUUID(),
    proposalId: input.proposalId,
    contractor: input.contractor,
    budgetAllocated: input.budgetAllocated,
    budgetSpent: 0,
    status: "active",
    createdAt: now,
    completedAt: null,
    evaluationRequestedAt: null,
  };
  store.projects.set(project.id, project);

  const milestones = [...input.milestones]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((m) => {
      const milestone: ProjectMilestone = {
        id: randomUUID(),
        projectId: project.id,
        title: m.title,
        dueDate: m.dueDate,
        orderIndex: m.orderIndex,
        status: "pending",
        completedAt: null,
      };
      store.milestones.set(milestone.id, milestone);
      return milestone;
    });

  const outcomeEvaluation: OutcomeEvaluation = {
    id: randomUUID(),
    projectId: project.id,
    promisedOutcome: input.promisedOutcome,
    measuredOutcome: null,
    createdAt: now,
    evaluatedAt: null,
  };
  store.outcomeEvaluations.set(outcomeEvaluation.id, outcomeEvaluation);

  return { project, milestones, outcomeEvaluation };
}

export function getProject(store: Store, id: string): Project {
  const project = store.projects.get(id);
  if (!project) {
    throw notFound(`project ${id} not found`);
  }
  return project;
}

export function listProjects(store: Store): Project[] {
  return [...store.projects.values()];
}

export function listMilestones(
  store: Store,
  projectId: string,
): ProjectMilestone[] {
  getProject(store, projectId);
  return [...store.milestones.values()]
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

export interface CompleteMilestoneResult {
  project: Project;
  milestone: ProjectMilestone;
}

export function completeMilestone(
  store: Store,
  auditEmitter: AuditEmitter,
  projectId: string,
  milestoneId: string,
): CompleteMilestoneResult {
  const project = getProject(store, projectId);
  const milestone = store.milestones.get(milestoneId);
  if (!milestone || milestone.projectId !== projectId) {
    throw notFound(
      `milestone ${milestoneId} not found on project ${projectId}`,
    );
  }
  if (milestone.status === "done") {
    throw conflict(`milestone ${milestoneId} is already completed`);
  }

  const now = new Date();
  milestone.status = "done";
  milestone.completedAt = now;
  auditEmitter.emit({
    type: "project_milestone.completed",
    projectId,
    at: now,
    details: { milestoneId },
  });

  const siblings = [...store.milestones.values()].filter(
    (m) => m.projectId === projectId,
  );
  const hasIncomplete = siblings.some((m) => m.status !== "done");
  if (!hasIncomplete) {
    project.status = "completed";
    project.completedAt = now;
    auditEmitter.emit({ type: "project.completed", projectId, at: now });
  }

  return { project, milestone };
}

export function recordBudgetSpent(
  store: Store,
  projectId: string,
  amount: number,
  description: string,
): Project {
  const project = getProject(store, projectId);
  const entryId = randomUUID();
  store.budgetSpentEntries.set(entryId, {
    id: entryId,
    projectId,
    amount,
    description,
    recordedAt: new Date(),
  });
  project.budgetSpent += amount;
  return project;
}

export interface SweepInput {
  now?: Date;
  evaluationDelayDays?: number;
}

export function sweepOutcomeEvaluations(
  store: Store,
  assignmentRequester: AssignmentRequester,
  input: SweepInput,
): string[] {
  const now = input.now ?? new Date();
  const delayDays = input.evaluationDelayDays ?? DEFAULT_EVALUATION_DELAY_DAYS;
  const delayMs = delayDays * 24 * 60 * 60 * 1000;
  const requestedProjectIds: string[] = [];

  for (const project of store.projects.values()) {
    if (project.status !== "completed") continue;
    if (project.evaluationRequestedAt) continue;
    if (!project.completedAt) continue;
    if (now.getTime() - project.completedAt.getTime() < delayMs) continue;

    assignmentRequester.request(project.id);
    project.evaluationRequestedAt = now;
    requestedProjectIds.push(project.id);
  }

  return requestedProjectIds;
}

export function submitOutcomeEvaluation(
  store: Store,
  evaluationId: string,
  measuredOutcome: string,
): OutcomeEvaluation {
  const evaluation = store.outcomeEvaluations.get(evaluationId);
  if (!evaluation) {
    throw notFound(`outcome evaluation ${evaluationId} not found`);
  }
  if (evaluation.measuredOutcome !== null) {
    throw conflict(`outcome evaluation ${evaluationId} already submitted`);
  }
  evaluation.measuredOutcome = measuredOutcome;
  evaluation.evaluatedAt = new Date();
  return evaluation;
}
