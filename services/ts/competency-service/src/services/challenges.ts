import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { CompetencyChallenge, ChallengeReason } from "../domain/types.js";
import { conflict, notFound } from "../errors.js";
import { requireCompetency, revokeCompetency } from "./competency.js";
import type { ReputationEmitter } from "../integrations.js";

// FR-027's negative factors, one per ChallengeReason -- an upheld challenge
// means the competency holder's claim was successfully disputed, and each
// reason maps onto the closest-matching negative reputation factor
// reputation-service defines.
const NEGATIVE_FACTOR_BY_CHALLENGE_REASON: Record<ChallengeReason, string> = {
  conflict: "undisclosed_conflict",
  false_claim: "misinformation",
  misconduct: "manipulation",
  credentials: "fraud",
};

// Deliberately larger in magnitude than DISCLOSURE_REPUTATION_DELTA and
// project-service's SUCCESSFUL_PROPOSAL_REPUTATION_DELTA: an upheld
// integrity challenge is a confirmed violation, not just a missed
// opportunity for credit, so it should weigh more than either positive
// factor -- a deliberate asymmetry, not a spec-derived number.
export const UPHELD_CHALLENGE_REPUTATION_DELTA = -20;

export function submitChallenge(
  store: Store,
  input: {
    competencyId: string;
    challengerId: string;
    reason: ChallengeReason;
    evidenceRef: string;
  },
): CompetencyChallenge {
  requireCompetency(store, input.competencyId);
  const challenge: CompetencyChallenge = {
    id: randomUUID(),
    competencyId: input.competencyId,
    challengerId: input.challengerId,
    evidenceRef: input.evidenceRef,
    reason: input.reason,
    status: "open",
    decision: null,
  };
  store.challenges.set(challenge.id, challenge);
  return challenge;
}

export function requireChallenge(store: Store, id: string): CompetencyChallenge {
  const challenge = store.challenges.get(id);
  if (!challenge) {
    throw notFound(`challenge ${id} not found`);
  }
  return challenge;
}

export function resolveChallenge(
  store: Store,
  reputationEmitter: ReputationEmitter,
  id: string,
  result: "upheld" | "dismissed",
): CompetencyChallenge {
  const challenge = requireChallenge(store, id);
  if (challenge.status === "upheld" || challenge.status === "dismissed") {
    throw conflict(`challenge ${id} is already resolved`);
  }
  challenge.status = result;
  if (result === "upheld") {
    const competency = revokeCompetency(store, challenge.competencyId);
    reputationEmitter.emit(
      competency.citizenId,
      NEGATIVE_FACTOR_BY_CHALLENGE_REASON[challenge.reason],
      UPHELD_CHALLENGE_REPUTATION_DELTA,
      challenge.id,
    );
  }
  return challenge;
}
