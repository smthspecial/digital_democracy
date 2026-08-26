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
