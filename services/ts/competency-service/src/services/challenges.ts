import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { CompetencyChallenge, ChallengeReason } from "../domain/types.js";
import { conflict, notFound } from "../errors.js";
import { requireCompetency, revokeCompetency } from "./competency.js";

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
  id: string,
  result: "upheld" | "dismissed",
): CompetencyChallenge {
  const challenge = requireChallenge(store, id);
  if (challenge.status === "upheld" || challenge.status === "dismissed") {
    throw conflict(`challenge ${id} is already resolved`);
  }
  challenge.status = result;
  if (result === "upheld") {
    revokeCompetency(store, challenge.competencyId);
  }
  return challenge;
}
