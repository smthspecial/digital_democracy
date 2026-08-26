// ConstitutionalReviewer models DP-034 (constitutional review), owned by
// SRV-012 which doesn't exist yet in this codebase and there is no
// constitutional.review queue here -- the development->voting transition
// calls this in-process, synchronously, instead of enqueuing to it.
export interface ConstitutionalReviewer {
  review(proposalId: string): { blocked: boolean };
}

export const defaultConstitutionalReviewer: ConstitutionalReviewer = {
  review: () => ({ blocked: false }),
};

// VoteSessionRequester models the voting-service call that creates a vote
// session once a proposal reaches voting; voting-service is a separate
// live process in production, so this is a fire-and-forget no-op here.
export interface VoteSessionRequester {
  requestSession(proposalId: string): void;
}

export const defaultVoteSessionRequester: VoteSessionRequester = {
  requestSession: () => {},
};

// AuditEmitter models the audit-service emission (DP-036) sent on every
// proposal status transition; audit-service isn't implemented here, so
// this is a no-op by default.
export interface AuditEmitter {
  emit(eventType: string, payload: Record<string, unknown>): void;
}

export const defaultAuditEmitter: AuditEmitter = {
  emit: () => {},
};
