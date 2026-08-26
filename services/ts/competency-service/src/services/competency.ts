import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { Competency } from "../domain/types.js";
import { COMPETENCY_STAGES } from "../domain/types.js";
import { conflict, notFound } from "../errors.js";
import { requireDomain } from "./domains.js";
import type { NotificationEmitter } from "../integrations.js";

// FR-026: fixed validity window before a competency requires re-review.
// The spec allows a 2-5 year range; 1 year is picked here as the concrete
// constant this implementation enforces.
export const COMPETENCY_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

export function applyForCompetency(
  store: Store,
  input: { citizenId: string; domainId: string },
): Competency {
  requireDomain(store, input.domainId);
  const competency: Competency = {
    id: randomUUID(),
    citizenId: input.citizenId,
    domainId: input.domainId,
    level: 0,
    status: "applied",
    stage: "application",
    grantedAt: null,
    expiresAt: null,
  };
  store.competencies.set(competency.id, competency);
  return competency;
}

export function requireCompetency(store: Store, id: string): Competency {
  const competency = store.competencies.get(id);
  if (!competency) {
    throw notFound(`competency ${id} not found`);
  }
  return competency;
}

export function advanceCompetency(store: Store, id: string): Competency {
  const competency = requireCompetency(store, id);
  if (competency.status !== "applied") {
    throw conflict(`competency ${id} is not in an advanceable state`);
  }
  const currentIndex = COMPETENCY_STAGES.indexOf(competency.stage);
  const nextStage = COMPETENCY_STAGES[currentIndex + 1];
  if (nextStage === undefined) {
    throw conflict(`competency ${id} has no further stage to advance to`);
  }
  competency.stage = nextStage;
  if (nextStage === "recorded_approval") {
    const grantedAt = new Date();
    competency.status = "active";
    competency.grantedAt = grantedAt;
    competency.expiresAt = new Date(grantedAt.getTime() + COMPETENCY_VALIDITY_MS);
  }
  return competency;
}

export function rejectCompetency(store: Store, id: string): Competency {
  const competency = requireCompetency(store, id);
  if (competency.status !== "applied") {
    throw conflict(`competency ${id} is not in a rejectable state`);
  }
  competency.status = "rejected";
  return competency;
}

export function revokeCompetency(store: Store, id: string): Competency {
  const competency = requireCompetency(store, id);
  competency.status = "revoked";
  return competency;
}

export function hasActiveCompetency(store: Store, citizenId: string, domainId: string): boolean {
  for (const competency of store.competencies.values()) {
    if (
      competency.citizenId === citizenId &&
      competency.domainId === domainId &&
      competency.status === "active"
    ) {
      return true;
    }
  }
  return false;
}

export function sweepExpiredCompetencies(store: Store, notifier: NotificationEmitter): number {
  const now = new Date();
  let expiredCount = 0;
  for (const competency of store.competencies.values()) {
    if (competency.status === "active" && competency.expiresAt !== null && competency.expiresAt < now) {
      competency.status = "expired";
      expiredCount += 1;
      notifier.notifyExpired(competency.citizenId, competency.id);
    }
  }
  return expiredCount;
}
