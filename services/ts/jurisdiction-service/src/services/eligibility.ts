import type { Store } from "../store.js";
import { validation } from "../errors.js";
import { collectSelfAndDescendantIds } from "./jurisdictions.js";
import { isResidencyCurrentAt } from "./residencies.js";

export const DEFAULT_MIN_RESIDENCY_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

// Interpretation: membership and residency must be held in the SAME
// jurisdiction, which may be scope_jurisdiction_id itself or any of its
// descendants -- e.g. a neighborhood-level membership plus neighborhood-level
// residency satisfies a city-level scope check. A membership in one branch
// combined with residency in an unrelated branch does not qualify.
export function checkEligibility(
  store: Store,
  citizenId: string,
  scopeJurisdictionId: string,
  minResidencyDays: number = DEFAULT_MIN_RESIDENCY_DAYS,
  now: Date = new Date(),
): EligibilityResult {
  if (!store.jurisdictions.getById(scopeJurisdictionId)) {
    throw validation("jurisdiction not found");
  }

  const candidateIds = collectSelfAndDescendantIds(store, scopeJurisdictionId);
  const reasons = new Set<string>();
  let hasMembership = false;

  for (const jurisdictionId of candidateIds) {
    if (!store.memberships.find(citizenId, jurisdictionId)) continue;
    hasMembership = true;

    const residency = store.residencies
      .listByCitizenAndJurisdiction(citizenId, jurisdictionId)
      .find((r) => isResidencyCurrentAt(r, now));
    if (!residency) {
      reasons.add("no current residency in a member jurisdiction");
      continue;
    }

    const residencyDays = Math.floor((now.getTime() - residency.start_date.getTime()) / MS_PER_DAY);
    if (residencyDays >= minResidencyDays) {
      return { eligible: true, reasons: [] };
    }
    reasons.add("residency duration below minimum required days");
  }

  if (!hasMembership) {
    reasons.add("no membership in scope jurisdiction or its descendants");
  }

  return { eligible: false, reasons: Array.from(reasons) };
}
