import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { ConflictOfInterest } from "../domain/types.js";
import { requireDomain } from "./domains.js";
import type { ExclusionEnforcer } from "../integrations.js";

export function declareConflict(
  store: Store,
  enforcer: ExclusionEnforcer,
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
