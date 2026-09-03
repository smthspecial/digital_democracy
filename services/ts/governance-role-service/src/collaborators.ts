// Seams for integrations that have no live implementation to call in this
// phase (audit-service's DP-043 gate, competency-service's COI signal,
// the actual protocol-change apply step, and notification/civic-duty-service
// dispatch from DP-050). Each interface gets a no-op/permissive default
// wired into buildServer() and can be swapped for a real client later
// without touching callers.
import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";

export interface ProtocolGateChecker {
  isConfirmed(actionRef: string): boolean;
}

// The return type allows a plain boolean (the permissive default, and every
// existing sync test double) alongside a real async HTTP call.
export interface COIChecker {
  hasConflict(citizenId: string, actionRef: string): boolean | Promise<boolean>;
}

export interface ProtocolChangeExecutor {
  execute(actionRef: string): void;
}

export interface NotificationEmitter {
  notify(roleId: string, message: string): void;
}

export interface ReplacementRequester {
  requestReplacement(roleId: string): void;
}

export interface AuditEmitter {
  emit(event: string, payload: Record<string, unknown>): void;
}

export const defaultProtocolGateChecker: ProtocolGateChecker = {
  isConfirmed: () => true,
};

export const defaultCOIChecker: COIChecker = {
  hasConflict: () => false,
};

// createHttpCOIChecker calls competency-service's real conflict-of-interest
// lookup (SRV-005, GET /competency/conflicts?citizen_id=...).
//
// The COIChecker contract carries an actionRef, but competency-service's
// conflict-of-interest records are scoped by domain (ConflictOfInterest,
// TBL-... has no `action_ref` concept), and identity-service's suspend/
// revoke actions -- the first non-protocol-change consumer of this seam,
// ARCH-010 EC-8 -- have no domain of their own to scope by either. Absent a
// domain to check against, this checks whether the citizen has *any*
// declared conflict of interest, in any domain: for an identity action,
// disqualifying an approver who has disclosed a conflict anywhere is a
// stricter, more conservative rule than allowing conflicted approvers
// through and matches SRV-011's "citizen with a COI in the affected domain
// is automatically excluded" intent (the affected domain is simply not
// nameable for this class of action). A protocol-change actionRef that
// resolves to a specific domain would need a scoped variant of this seam.
//
// Fails closed, symmetric with createHttpApprovalGate (ARCH-010 EC-16): an
// unreachable competency-service or malformed response is treated as a
// conflict (blocks the approval) rather than silently waving it through.
export function createHttpCOIChecker(baseUrl: string): COIChecker {
  return {
    async hasConflict(citizenId) {
      try {
        const res = await fetch(`${baseUrl}/competency/conflicts?citizen_id=${encodeURIComponent(citizenId)}`);
        if (!res.ok) return true;
        const body = (await res.json()) as { has_conflict?: boolean };
        return body.has_conflict !== false;
      } catch {
        return true;
      }
    },
  };
}

export const defaultProtocolChangeExecutor: ProtocolChangeExecutor = {
  execute: () => undefined,
};

export const defaultNotificationEmitter: NotificationEmitter = {
  notify: () => undefined,
};

export const defaultReplacementRequester: ReplacementRequester = {
  requestReplacement: () => undefined,
};

export const defaultAuditEmitter: AuditEmitter = {
  emit: () => undefined,
};

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// Maps this service's own event vocabulary onto audit-service's fixed
// action_type enum (TBL-034), same convention proposal-service's
// AuditEmitter uses. protocol_change.executed is literally a protocol/rule
// change, so it gets TBL-034's rule_change bucket; every other event here
// (role creation, approval recording, offboarding flags) is a governance
// procedural action without a more specific TBL-034 bucket, so it falls
// under admin_action.
const AUDIT_ACTION_TYPE_BY_EVENT: Record<string, string> = {
  "protocol_change.executed": "rule_change",
};

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). Fire-and-forget per the AuditEmitter contract, same as every
// other cross-service notification in this codebase: a downed
// NATS/audit-service must never block the governance action that
// triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    emit(event, payload) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: AUDIT_ACTION_TYPE_BY_EVENT[event] ?? "admin_action",
        actor_ref: "governance-role-service",
        payload,
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}
