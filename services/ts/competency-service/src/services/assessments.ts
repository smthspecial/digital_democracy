import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { ExpertAssessment } from "../domain/types.js";
import { forbidden } from "../errors.js";
import { requireDomain } from "./domains.js";
import { hasActiveCompetency } from "./competency.js";
import { hasConflictOfInterest } from "./conflicts.js";

export function publishAssessment(
  store: Store,
  input: {
    proposalId: string;
    citizenId: string;
    domainId: string;
    content: string;
    score: number;
  },
): ExpertAssessment {
  requireDomain(store, input.domainId);
  if (!hasActiveCompetency(store, input.citizenId, input.domainId)) {
    throw forbidden("citizen has no active competency in this domain");
  }
  if (hasConflictOfInterest(store, input.citizenId, input.domainId)) {
    throw forbidden("citizen has an undisclosed conflict of interest in this domain");
  }
  const assessment: ExpertAssessment = {
    id: randomUUID(),
    proposalId: input.proposalId,
    expertId: input.citizenId,
    domainId: input.domainId,
    content: input.content,
    score: input.score,
    createdAt: new Date(),
  };
  store.assessments.set(assessment.id, assessment);
  return assessment;
}
