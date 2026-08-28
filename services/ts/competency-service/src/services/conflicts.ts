import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { ConflictOfInterest } from "../domain/types.js";
import { requireDomain } from "./domains.js";
import type { ExclusionEnforcer, ReputationEmitter } from "../integrations.js";

// FR-027's "disclosure" positive factor: a citizen proactively declaring a
// conflict of interest is exactly this factor by name.
export const DISCLOSURE_REPUTATION_DELTA = 5;

export function declareConflict(
  store: Store,
  enforcer: ExclusionEnforcer,
  reputationEmitter: ReputationEmitter,
  input: { citizenId: string; domainId: string; description: string },
): ConflictOfInterest {
  requireDomain(store, input.domainId);
  const coi: ConflictOfInterest = {
    id: randomUUID(),
    citizenId: input.citizenId,
    domainId: input.domainId,
    description: input.description,
    disclosedAt: new Date(),
  };
  store.conflicts.set(coi.id, coi);
  enforcer.exclude(input.citizenId, input.domainId);
  reputationEmitter.emit(input.citizenId, "disclosure", DISCLOSURE_REPUTATION_DELTA, coi.id);
  return coi;
}

export function hasConflictOfInterest(store: Store, citizenId: string, domainId: string): boolean {
  for (const coi of store.conflicts.values()) {
    if (coi.citizenId === citizenId && coi.domainId === domainId) {
      return true;
    }
  }
  return false;
}
