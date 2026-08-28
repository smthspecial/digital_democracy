// TBL-029 also defines 'planned' and 'in_progress'/'cancelled' project
// states; this phase creates a project directly once a proposal is
// approved (execution starts immediately) and only ever transitions it to
// 'completed', so those other states aren't modeled.
export type ProjectStatus = "active" | "completed";

export interface Project {
  id: string;
  proposalId: string;
  contractor: string;
  budgetAllocated: number;
  budgetSpent: number;
  status: ProjectStatus;
  createdAt: Date;
  completedAt: Date | null;
  // Not a TBL-029 column: tracks whether DP-053's sweep already requested
  // an outcome-evaluation assignment for this project, so the daily cron
  // only fires once per project instead of re-requesting every run.
  evaluationRequestedAt: Date | null;
}

// TBL-030's 'delayed' status requires monitoring due dates against the
// current date, which no data process in scope here drives -- only
// 'pending' and 'done' are used.
export type MilestoneStatus = "pending" | "done";

export interface BudgetSpentEntry {
  id: string;
  projectId: string;
  amount: number;
  description: string;
  recordedAt: Date;
}

export interface ProjectMilestone {
  id: string;
  projectId: string;
  title: string;
  dueDate: string;
  orderIndex: number;
  status: MilestoneStatus;
  completedAt: Date | null;
}

// TBL-031's 'evaluation' categorization (successful/partial/unsuccessful)
// is a human judgment call by the submitting auditor/oversight role
// (DP-022's actor), not something this service derives from comparing the
// promised/measured outcome text -- it is accepted as explicit input on
// submission, the same way identity-service accepts a verification's
// outcome rather than deriving it (see identity-service's DP-002).
export type EvaluationResult = "successful" | "partial" | "unsuccessful";

export interface OutcomeEvaluation {
  id: string;
  projectId: string;
  objective: string;
  promisedOutcome: string;
  measuredOutcome: string | null;
  evaluation: EvaluationResult | null;
  createdAt: Date;
  evaluatedAt: Date | null;
}
