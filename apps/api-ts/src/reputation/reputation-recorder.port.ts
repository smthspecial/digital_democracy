import type { RecordDeltaInput } from "./reputation.types.js";

// Cross-module port implemented by ReputationService, consumed by
// ProjectModule (DP-038: "triggered by... project-service (outcome
// success/failure)"). All services share one app/database (ADR-027/028), so
// this is an ordinary in-process Nest import (ReputationModule exports this
// token), not an HTTP seam -- same shape as GOVERNANCE_ROLE_CHECKER.
//
// competency-service and deliberation-service are also named in SRV-014.md
// as DP-038 triggers ("challenge resolved", "contribution logged") but
// neither of those already-built modules is wired to call this port --
// that wiring is separate follow-up work, not part of migrating the six
// services in this pass (mirrors ADR-025's own "none of these call sites
// are wired yet" honesty about iam-service's callers).
export const REPUTATION_RECORDER = Symbol("REPUTATION_RECORDER");

export interface ReputationRecorder {
  // DP-038: "Negative deltas require an upstream authoritative decision.
  // Self-reported negative deltas are not permitted" -- enforced by this
  // port having no HTTP-exposed equivalent (mirrors BudgetService.
  // recordLedgerEntry), not by a sign check here; callers are trusted,
  // already-authoritative service code.
  recordDelta(input: RecordDeltaInput): Promise<void>;
}
