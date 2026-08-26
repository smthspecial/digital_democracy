// ThresholdChecker models DP-028's async check against proposal-service --
// whether any proposal linked to this problem has crossed its support
// threshold. proposal-service isn't implemented here, so the default is a
// no-op; a real integration would enqueue/call out instead.
export interface ThresholdChecker {
  checkThreshold(problemId: string, supportCount: number): void;
}

export const noopThresholdChecker: ThresholdChecker = {
  checkThreshold() {
    /* no linked proposal-service to notify yet */
  },
};

// AuditEmitter models the DP-036 audit-service emission on problem creation
// and status changes; audit-service isn't implemented here, so this is a
// no-op by default.
export interface AuditEmitter {
  emit(eventType: string, payload: Record<string, unknown>): void;
}

export const noopAuditEmitter: AuditEmitter = {
  emit() {
    /* no audit-service to notify yet */
  },
};
