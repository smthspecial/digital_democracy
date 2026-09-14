export type ProjectStatus = "planned" | "in_progress" | "completed" | "cancelled";
export type ProjectMilestoneStatus = "pending" | "done" | "delayed";
export type OutcomeEvaluationResult = "successful" | "partial" | "unsuccessful";

export interface Project {
  id: string;
  proposalId: string;
  timelineStart: Date;
  timelineEnd: Date;
  budgetAllocated: number | null;
  budgetSpent: number | null;
  contractor: string;
  status: ProjectStatus;
}

export interface ProjectMilestone {
  id: string;
  projectId: string;
  name: string;
  dueDate: Date;
  completedAt: Date | null;
  status: ProjectMilestoneStatus;
}

export interface OutcomeEvaluation {
  id: string;
  projectId: string;
  objective: string;
  promisedOutcome: string;
  measuredOutcome: string;
  evaluation: OutcomeEvaluationResult;
  evaluatedAt: Date;
}

// Cross-table read used only to resolve DP-018's ledger push and DP-022's
// reputation trigger -- proposal lives in the same database (proposal-service
// is already built), so this is a same-DB join, not a cross-service call.
export interface ProjectProposalContext {
  proposalAuthorId: string;
  scopeJurisdictionId: string | null;
}

export interface UpdateMilestoneInput {
  completedAt?: Date | null;
  status: ProjectMilestoneStatus;
}

export interface InsertEvaluationInput {
  projectId: string;
  objective: string;
  promisedOutcome: string;
  measuredOutcome: string;
  evaluation: OutcomeEvaluationResult;
}

export interface ProjectListFilter {
  status?: ProjectStatus;
}

export interface ProjectMilestoneListFilter {
  projectId?: string;
}

export interface OutcomeEvaluationListFilter {
  projectId?: string;
}
