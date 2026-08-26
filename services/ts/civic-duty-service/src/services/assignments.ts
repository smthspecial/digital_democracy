import type { Store } from "../store.js";
import type { CivicAssignment, CivicAssignmentStatus, CivicAssignmentType } from "../domain/types.js";
import { computeWeight, pickWeighted, type RandomSource, type WeightedCandidate } from "./weighting.js";
import { conflict, notFound, validation } from "../errors.js";

export interface AssignmentCandidateInput {
  citizenId: string;
  sphereRelevant: boolean;
  competencyMatch: boolean;
}

export interface GenerateAssignmentInput {
  type: CivicAssignmentType;
  targetRef: string;
  candidates: AssignmentCandidateInput[];
}

export interface GenerateAssignmentResult {
  assignment: CivicAssignment;
  weights: WeightedCandidate[];
}

export function generateAssignment(
  store: Store,
  random: RandomSource,
  input: GenerateAssignmentInput,
): GenerateAssignmentResult {
  if (input.candidates.length === 0) {
    throw validation("At least one candidate is required");
  }
  const weights = input.candidates.map((candidate) =>
    computeWeight(
      {
        citizenId: candidate.citizenId,
        sphereRelevant: candidate.sphereRelevant,
        competencyMatch: candidate.competencyMatch,
        openAssignmentCount: store.countOpenAssignments(candidate.citizenId),
      },
      random,
    ),
  );
  const picked = pickWeighted(weights, random);
  const assignment = store.createAssignment({
    citizenId: picked.citizenId,
    type: input.type,
    targetRef: input.targetRef,
    assignedAt: new Date(),
    dueAt: null,
    status: "assigned",
  });
  return { assignment, weights };
}

export type AssignmentAction = "accept" | "abandon" | "complete";

export function transitionAssignment(store: Store, id: string, action: AssignmentAction): CivicAssignment {
  const assignment = store.getAssignment(id);
  if (!assignment) {
    throw notFound(`Assignment ${id} not found`);
  }
  if (assignment.status !== "assigned") {
    throw conflict(`Assignment ${id} is ${assignment.status}, cannot ${action}`);
  }
  // TBL-024's status enum has no separate "accepted" value, so accepting an
  // assignment only validates it is still awaiting action; it stays "assigned".
  if (action === "accept") {
    return assignment;
  }
  const nextStatus: CivicAssignmentStatus = action === "abandon" ? "abandoned" : "completed";
  return store.saveAssignment({ ...assignment, status: nextStatus });
}

export interface RebalanceResult {
  overloaded: string[];
  underloaded: string[];
}

export function rebalance(store: Store, candidateIds: string[], overloadThreshold: number): RebalanceResult {
  const overloaded: string[] = [];
  const underloaded: string[] = [];
  for (const citizenId of candidateIds) {
    const openCount = store.countOpenAssignments(citizenId);
    if (openCount === 0) {
      underloaded.push(citizenId);
    } else if (openCount > overloadThreshold) {
      overloaded.push(citizenId);
    }
  }
  return { overloaded, underloaded };
}

export function refreshAuditPool(
  store: Store,
  random: RandomSource,
  candidateIds: string[],
  count: number,
): CivicAssignment[] {
  const pool = candidateIds.filter((id) => !store.hasOpenAssignmentOfType(id, "audit_review"));
  const selectedCount = Math.min(count, pool.length);
  const selected: string[] = [];
  for (let i = 0; i < selectedCount; i += 1) {
    const index = Math.floor(random() * pool.length);
    selected.push(...pool.splice(index, 1));
  }
  return selected.map((citizenId) =>
    store.createAssignment({
      citizenId,
      type: "audit_review",
      targetRef: "audit_pool_refresh",
      assignedAt: new Date(),
      dueAt: null,
      status: "assigned",
    }),
  );
}
