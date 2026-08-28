import { randomUUID } from "node:crypto";

// ConstitutionalReviewer models DP-034 (constitutional review), owned by
// SRV-012/audit-service. There is no constitutional.review queue here, so
// the development->voting transition calls this in-process, synchronously,
// instead of enqueuing to it. changeSummary is matched against protected
// right names by audit-service's assessor (a keyword-match placeholder for
// the elevated human review process AUTH-007 eventually plugs into), so the
// caller should pass real proposal text, not just the id.
export interface ConstitutionalReviewer {
  review(proposalId: string, changeSummary: string): Promise<{ blocked: boolean }>;
}

export const defaultConstitutionalReviewer: ConstitutionalReviewer = {
  review: async () => ({ blocked: false }),
};

// createHttpConstitutionalReviewer calls audit-service's real DP-034
// endpoint (SRV-012, POST /audit/proposals/:id/constitutional-review).
// Fails closed: if audit-service is unreachable or errors, the promise
// rejects rather than silently letting the proposal through -- a downed
// constitutional-review gate must not become an open one.
export function createHttpConstitutionalReviewer(baseUrl: string): ConstitutionalReviewer {
  return {
    async review(proposalId, changeSummary) {
      const res = await fetch(
        `${baseUrl}/audit/proposals/${encodeURIComponent(proposalId)}/constitutional-review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ change_summary: changeSummary }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `constitutional review request for proposal ${proposalId} failed with status ${res.status}`,
        );
      }
      const body = (await res.json()) as { blocked: boolean };
      return { blocked: body.blocked };
    },
  };
}

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
// proposal status transition; no-op by default.
export interface AuditEmitter {
  emit(eventType: string, payload: Record<string, unknown>): void;
}

export const defaultAuditEmitter: AuditEmitter = {
  emit: () => {},
};

// Maps this service's own event vocabulary onto audit-service's fixed
// action_type enum (TBL-034). "proposal_status_changed" also covers
// deadlock-track entry: it isn't a `status` field change, but it is the
// same kind of governance-process-state event, and proliferating a
// dedicated enum value per local event name would outgrow what TBL-034
// is meant to be (a small, fixed classification, not a free-text log).
const AUDIT_ACTION_TYPE_BY_EVENT: Record<string, string> = {
  "proposal.created": "proposal_created",
  "proposal.status_changed": "proposal_status_changed",
  "proposal.deadlock_entered": "proposal_status_changed",
};

// createHttpAuditEmitter calls audit-service's real DP-036 endpoint
// (SRV-012, POST /audit/log). Fire-and-forget per the AuditEmitter
// contract: a downed audit trail must never block the governance action
// that triggered it, so failures are swallowed here, not surfaced.
export function createHttpAuditEmitter(baseUrl: string): AuditEmitter {
  return {
    emit(eventType, payload) {
      fetch(`${baseUrl}/audit/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action_type: AUDIT_ACTION_TYPE_BY_EVENT[eventType] ?? "system_update",
          actor_ref: "proposal-service",
          payload,
          idempotency_key: randomUUID(),
        }),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}

// AssignmentChecker models the reviewer-panel staffing that, in a full
// deployment, governance-role-service's review-body selection (DP-065)
// would perform when a proposal enters the citizen_assembly_review /
// escalation_review / constitutional_review deadlock stages (FR-034).
// governance-role-service isn't called over HTTP here (same simplification
// as every other cross-service call in this codebase), so this interface is
// the seam: it just answers whether a given reviewer is currently assigned
// to review a given proposal's deadlock.
export interface AssignmentChecker {
  isAssignedReviewer(reviewerId: string, proposalId: string): boolean;
}

export const defaultAssignmentChecker: AssignmentChecker = {
  isAssignedReviewer: () => true,
};

// ScopeEscalationRequester models DP-020's "enqueues DP-030 for routing to
// an independent review body" and DP-058's daily stale-challenge sweep,
// both of which hand an unresolved scope challenge to governance-role-
// service's review-body selection. That selection endpoint (DP-065) isn't
// implemented in governance-role-service yet, so this is a documented stub
// only -- same simplification as every other cross-service call in this
// codebase -- rather than the silently-fictional "called by proposal-
// service" dependency SRV-011 previously claimed with no seam behind it at
// all.
export interface ScopeEscalationRequester {
  requestReviewBody(proposalId: string, challengeId: string): void;
}

export const defaultScopeEscalationRequester: ScopeEscalationRequester = {
  requestReviewBody: () => {},
};
