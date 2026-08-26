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

// TBL-031's 'objective' and 'evaluation' columns are out of scope: DP-022
// only ever writes promised/measured outcome text, leaving the
// successful/partial/unsuccessful categorization to the human audit
// process reading both fields once they're public, not to this service.
export interface OutcomeEvaluation {
  id: string;
  projectId: string;
  promisedOutcome: string;
  measuredOutcome: string | null;
  createdAt: Date;
  evaluatedAt: Date | null;
}
