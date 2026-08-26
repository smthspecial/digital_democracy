import { randomUUID } from "node:crypto";
import type { AuditEmitter, ThresholdChecker } from "../collaborators.js";
import type {
  Problem,
  ProblemStatus,
  SubmitProblemInput,
} from "../domain/types.js";
import { conflict, notFound } from "../errors.js";
import type { Store } from "../store.js";

const FORWARD_TRANSITIONS: Record<ProblemStatus, ProblemStatus[]> = {
  open: ["proposing"],
  proposing: ["closed"],
  closed: [],
};

export function submitProblem(
  store: Store,
  input: SubmitProblemInput,
  audit: AuditEmitter,
): Problem {
  const problem: Problem = {
    id: randomUUID(),
    citizenId: input.citizenId,
    title: input.title,
    description: input.description,
    affectedArea: input.affectedArea,
    candidateScope: input.candidateScope,
    status: "open",
    createdAt: new Date(),
  };
  store.createProblem(problem);
  audit.emit("problem.created", { problemId: problem.id });
  return problem;
}

export function listProblems(store: Store): Problem[] {
  return store.listProblems();
}

export function getProblem(store: Store, id: string): Problem {
  const problem = store.getProblem(id);
  if (!problem) {
    throw notFound("Problem not found");
  }
  return problem;
}

export function endorseProblem(
  store: Store,
  problemId: string,
  citizenId: string,
  thresholdChecker: ThresholdChecker,
): number {
  const problem = store.getProblem(problemId);
  if (!problem) {
    throw notFound("Problem not found");
  }
  if (store.hasSupport(problemId, citizenId)) {
    throw conflict("Citizen has already endorsed this problem");
  }
  store.addSupport({
    id: randomUUID(),
    problemId,
    citizenId,
    createdAt: new Date(),
  });
  const supportCount = store.countSupport(problemId);
  thresholdChecker.checkThreshold(problemId, supportCount);
  return supportCount;
}

export function transitionProblemStatus(
  store: Store,
  id: string,
  nextStatus: ProblemStatus,
  audit: AuditEmitter,
): Problem {
  const problem = store.getProblem(id);
  if (!problem) {
    throw notFound("Problem not found");
  }
  const allowed = FORWARD_TRANSITIONS[problem.status];
  if (!allowed.includes(nextStatus)) {
    throw conflict(
      `Cannot transition problem from '${problem.status}' to '${nextStatus}'`,
    );
  }
  const updated: Problem = { ...problem, status: nextStatus };
  store.updateProblem(updated);
  audit.emit("problem.status_changed", {
    problemId: id,
    from: problem.status,
    to: nextStatus,
  });
  return updated;
}
