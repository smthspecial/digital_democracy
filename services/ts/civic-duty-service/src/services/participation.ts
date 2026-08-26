import type { Store } from "../store.js";
import type { InactivityStage, ParticipationRecord } from "../domain/types.js";
import type { NotificationEmitter } from "../notifications.js";

export interface ParticipationScoreInput {
  citizenId: string;
  votingCount: number;
  reviewCount: number;
  auditCount: number;
  quotaTarget: number;
}

// FR-052: score is an equal-weighted sum -- 1 point each for voting, review,
// and audit participation. It is informational only and never feeds voting weight.
export function recordParticipationScores(
  store: Store,
  period: string,
  inputs: ParticipationScoreInput[],
): ParticipationRecord[] {
  return inputs.map((input) => {
    const existing = store.getParticipationRecord(input.citizenId, period);
    const score = input.votingCount + input.reviewCount + input.auditCount;
    return store.upsertParticipationRecord({
      id: existing?.id,
      citizenId: input.citizenId,
      period,
      score,
      quotaTarget: input.quotaTarget,
      exemptionStatus: existing?.exemptionStatus ?? "none",
      inactivityStage: existing?.inactivityStage ?? 0,
    });
  });
}

// DP-049: steps inactivityStage one stage at a time (0->1->2->3) while a
// citizen's period score stays below the given threshold. Once the score
// recovers to or above threshold, the stage resets straight to 0 rather than
// stepping back down one stage at a time -- recovery is treated as a clean
// slate, not a gradual de-escalation. Notifications fire only on the actual
// transition into stage 1 or stage 2, not on every sweep.
export function sweepInactivity(
  store: Store,
  notifier: NotificationEmitter,
  period: string,
  inactivityThresholdScore: number,
): ParticipationRecord[] {
  const records = store.listParticipationRecordsByPeriod(period);
  return records.map((record) => {
    const belowThreshold = record.score < inactivityThresholdScore;
    const nextStage: InactivityStage = belowThreshold
      ? (Math.min(3, record.inactivityStage + 1) as InactivityStage)
      : 0;

    if (nextStage === record.inactivityStage) {
      return record;
    }

    const updated = store.upsertParticipationRecord({ ...record, inactivityStage: nextStage });
    if (nextStage === 1) {
      notifier.notify({ citizenId: record.citizenId, kind: "inactivity_reminder", period });
    } else if (nextStage === 2) {
      notifier.notify({ citizenId: record.citizenId, kind: "inactivity_reduced", period });
    }
    return updated;
  });
}
