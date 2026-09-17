import { Injectable, Logger } from "@nestjs/common";
import { auditEmitFailuresTotal } from "../metrics/metrics.js";

export const AUDIT_EMITTER = Symbol("AUDIT_EMITTER");

// DP-036 ("Audit log append") is owned by audit-service (SRV-012, apps/api-go)
// -- this app has no audit_log table. Fires only where a DP doc in this pass
// explicitly says "Emits DP-036" (DP-002 on activation, DP-003, DP-005;
// ADR-030) via HTTP when AUDIT_SERVICE_URL is set, else a no-op -- the same
// seam shape as api-go's AuditEmitter (apps/api-go/internal/delegation/service.go).
//
// BUG-001 (fixed here): this used to POST camelCase JSON to a route
// (/audit/events) that doesn't exist. audit-service's real contract is
// POST /audit/log (apps/api-go/internal/audit/router.go), decoding
// snake_case {action_type, actor_ref, payload: <string>, idempotency_key}
// (apps/api-go/internal/audit/handlers.go's `append`) -- payload is a JSON
// STRING (audit-service hashes it, TBL-034.payload_hash, and never stores
// the plaintext -- see audit-log-excludes-private-data), not a nested
// object. action_type is also a closed 7-value enum
// (apps/api-go/internal/audit/domain.go's validAction/actionAliases), so
// this app's dotted domain verbs (identity.citizen_activated, iam.revoked,
// ...) must map onto it; the dotted verb survives inside the payload for
// granularity. The reference shape is apps/api-go's own
// internal/auth/seams_http.go httpAuditEmitter, which already speaks this
// contract correctly.
export interface AuditEvent {
  actionType: string;
  actorRef: string;
  payload: Record<string, unknown>;
  /** Dedupe key for at-least-once redelivery (audit_log.idempotency_key). Optional: most call sites are synchronous one-shot writes with nothing to retry against. */
  idempotencyKey?: string;
}

export interface AuditEmitter {
  emit(event: AuditEvent): Promise<void>;
}

// This app's dotted domain verbs -> audit-service's closed TBL-034
// action_type enum (proposal_created | proposal_status_changed |
// vote_certified | system_update | rule_change | admin_action |
// identity_event). The dotted verb is not lost -- it travels inside the
// payload as `event`, alongside every other field the caller passed.
// admin_action: an administrative/governance actor deciding something about
// another actor or the system's rule set (iam.*, governance_role.*).
// identity_event: citizen identity lifecycle (identity.*).
// proposal_created: the one call site whose dotted verb already names an
// exact enum member.
// system_update: everything else -- a citizen or system recording routine
// state (problem/project/deliberation/reputation/budget/civic_duty), none
// of which is an admin action taken over someone else.
const ACTION_TYPE_BY_VERB: Record<string, string> = {
  "identity.citizen_activated": "identity_event",
  "identity.citizen_revoked": "identity_event",
  "identity.duplicate_signals_flagged": "identity_event",
  "competency.expiry_swept": "system_update",
  "iam.policy_proposed": "admin_action",
  "iam.attachment_proposed": "admin_action",
  "iam.endorsement_submitted": "admin_action",
  "iam.revoked": "admin_action",
  "governance_role.approval_submitted": "admin_action",
  "proposal.created": "proposal_created",
  "proposal.status_changed": "proposal_status_changed",
  "problem.created": "system_update",
  "deliberation.argument_posted": "system_update",
  "reputation.delta_recorded": "system_update",
  "budget.ledger_entry_recorded": "system_update",
  "project.milestone_reported": "system_update",
  "project.outcome_evaluation_submitted": "system_update",
  "civic_duty.assignment_completed": "system_update",
  "civic_duty.assignment_abandoned": "system_update",
  "civic_duty.exemption_claimed": "system_update",
  "competency.granted": "admin_action",
};

/** Exported so the mapping is independently unit-testable (no I/O) -- falls back to `system_update` for any verb not in the table above rather than dropping the entry, and logs so a genuinely new verb gets a real mapping decision instead of silently miscategorizing forever. */
export function auditActionTypeFor(verb: string, logger?: Logger): string {
  const mapped = ACTION_TYPE_BY_VERB[verb];
  if (mapped) {
    return mapped;
  }
  logger?.warn(`no audit action_type mapping for verb "${verb}" -- defaulting to system_update`);
  return "system_update";
}

@Injectable()
export class HttpAuditEmitter implements AuditEmitter {
  private readonly logger = new Logger(HttpAuditEmitter.name);
  private readonly auditServiceUrl = process.env.AUDIT_SERVICE_URL;

  async emit(event: AuditEvent): Promise<void> {
    if (!this.auditServiceUrl) {
      return;
    }
    const body = {
      action_type: auditActionTypeFor(event.actionType, this.logger),
      actor_ref: event.actorRef,
      payload: JSON.stringify({ event: event.actionType, ...event.payload }),
      ...(event.idempotencyKey ? { idempotency_key: event.idempotencyKey } : {}),
    };
    try {
      const response = await fetch(`${this.auditServiceUrl}/audit/log`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // Escalated from warn: a silent warn on a 404/400 is exactly what
        // let BUG-001 ship four independent contract breaks unnoticed.
        this.logger.error(
          `audit emit failed: HTTP ${response.status} for action_type=${body.action_type} (verb=${event.actionType})`,
        );
        auditEmitFailuresTotal.inc();
      }
    } catch (err) {
      // Best-effort: an audit delivery failure must never block the
      // governance process that triggered it (mirrors notification-service's
      // key rule, SRV-015) -- but still logged loudly, not swallowed.
      this.logger.error(`audit emit failed: ${(err as Error).message} for action_type=${body.action_type}`);
      auditEmitFailuresTotal.inc();
    }
  }
}
