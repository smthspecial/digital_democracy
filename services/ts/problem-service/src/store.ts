import type { Problem, ProblemSupport } from "./domain/types.js";

export interface Store {
  createProblem(problem: Problem): void;
  getProblem(id: string): Problem | undefined;
  listProblems(): Problem[];
  updateProblem(problem: Problem): void;
  addSupport(support: ProblemSupport): void;
  hasSupport(problemId: string, citizenId: string): boolean;
  countSupport(problemId: string): number;
}

function supportKey(problemId: string, citizenId: string): string {
  return `${problemId}:${citizenId}`;
}

export function createStore(): Store {
  const problems = new Map<string, Problem>();
  const supports = new Map<string, ProblemSupport>();
  const supportCounts = new Map<string, number>();

  return {
    createProblem(problem) {
      problems.set(problem.id, problem);
    },
    getProblem(id) {
      return problems.get(id);
    },
    listProblems() {
      return Array.from(problems.values());
    },
    updateProblem(problem) {
      problems.set(problem.id, problem);
    },
    addSupport(support) {
      supports.set(supportKey(support.problemId, support.citizenId), support);
      supportCounts.set(
        support.problemId,
        (supportCounts.get(support.problemId) ?? 0) + 1,
      );
    },
    hasSupport(problemId, citizenId) {
      return supports.has(supportKey(problemId, citizenId));
    },
    countSupport(problemId) {
      return supportCounts.get(problemId) ?? 0;
    },
  };
}
