import type {
  Project,
  ProjectMilestone,
  OutcomeEvaluation,
  BudgetSpentEntry,
} from "./domain/types.js";

export interface Store {
  projects: Map<string, Project>;
  milestones: Map<string, ProjectMilestone>;
  outcomeEvaluations: Map<string, OutcomeEvaluation>;
  budgetSpentEntries: Map<string, BudgetSpentEntry>;
}

export function createStore(): Store {
  return {
    projects: new Map(),
    milestones: new Map(),
    outcomeEvaluations: new Map(),
    budgetSpentEntries: new Map(),
  };
}
