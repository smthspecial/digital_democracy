// Seam for DP-033: a real deployment would suspend open expert_assessment
// submissions and active governance_role assignments in the conflicted
// domain (governance_role lives in another service). Here we only invoke
// the interface so callers can verify it fires with the right arguments.
export interface ExclusionEnforcer {
  exclude(citizenId: string, domainId: string): void;
}

export const noopExclusionEnforcer: ExclusionEnforcer = {
  exclude: () => {},
};

// Seam for DP-039: a real deployment would email/push-notify the holder
// whose competency just expired. No-op by default.
export interface NotificationEmitter {
  notifyExpired(citizenId: string, competencyId: string): void;
}

export const noopNotificationEmitter: NotificationEmitter = {
  notifyExpired: () => {},
};

// ReputationEmitter models DP-038 (reputation-service ingest). Two events
// here map cleanly onto reputation-service's factor types (FR-027):
// proactively declaring a conflict of interest is exactly the "disclosure"
// positive factor, and an upheld challenge is exactly the kind of
// integrity violation the negative factors (misinformation,
// undisclosed_conflict, manipulation, fraud) exist for -- see
// declareConflict/resolveChallenge in services/conflicts.ts and
// services/challenges.ts. Fire-and-forget, matching every other emitter in
// this codebase: a downed reputation-service must not block the action
// that triggered it.
export interface ReputationEmitter {
  emit(citizenId: string, factorType: string, delta: number, sourceRef: string): void;
}

export const noopReputationEmitter: ReputationEmitter = {
  emit: () => {},
};

// createHttpReputationEmitter calls reputation-service's real
// POST /reputation/records (SRV-014).
export function createHttpReputationEmitter(baseUrl: string): ReputationEmitter {
  return {
    emit(citizenId, factorType, delta, sourceRef) {
      fetch(`${baseUrl}/reputation/records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          citizen_id: citizenId,
          factor_type: factorType,
          delta,
          source_ref: sourceRef,
        }),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}
