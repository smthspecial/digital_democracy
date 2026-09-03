// Seams for this service's cross-service dependencies. GovernanceRoleChecker
// is the one live dependency ARCH-024 §2 requires: every propose/endorse/
// revoke handler verifies the acting citizen's claimed role_type against
// governance-role-service, live, never trusted from the request body. It
// gets a permissive default (always true) so the service runs standalone in
// tests/dev, and a real HTTP implementation below. AuditEmitter mirrors
// governance-role-service's own audit.append seam (ADR-023) exactly, wired
// into buildServer() whenever NATS_URL is set.
import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";
import type { RoleType } from "./domain/types.js";

// The return type allows a plain boolean (the permissive default, and every
// existing sync test double) alongside a real async HTTP call.
export interface GovernanceRoleChecker {
  hasActiveRole(citizenId: string, roleType: RoleType): boolean | Promise<boolean>;
}

export interface AuditEmitter {
  emit(event: string, payload: Record<string, unknown>): void;
}

export const defaultGovernanceRoleChecker: GovernanceRoleChecker = {
  hasActiveRole: () => true,
};

export const defaultAuditEmitter: AuditEmitter = {
  emit: () => undefined,
};

interface GovernanceRoleRow {
  term_start: string;
  term_end: string;
}

// Mirrors governance-role-service's own isRoleActive helper
// (src/services/approvals.ts) -- a role's term must currently cover now().
function isRoleActive(role: GovernanceRoleRow, now: Date): boolean {
  return (
    new Date(role.term_start).getTime() <= now.getTime() &&
    now.getTime() <= new Date(role.term_end).getTime()
  );
}

// createHttpGovernanceRoleChecker calls governance-role-service's real,
// already-existing GET /governance-roles/roles?citizen_id=...&role_type=...
// (SRV-011, src/routes/roles.ts). That endpoint lists every role matching
// the filter regardless of term liveness -- it does not filter by term
// liveness itself -- so this checks the returned rows for one whose term
// currently covers now(), mirroring governance-role-service's own
// isRoleActive helper rather than inventing a different liveness rule.
//
// Fails closed (ARCH-024 §2, symmetric with every other HTTP seam in this
// codebase -- createHttpCOIChecker, createHttpJurisdictionClient): an
// unreachable governance-role-service or a non-2xx response is treated as
// "no active role" -- the restrictive outcome -- rather than silently
// trusting the caller's claim.
export function createHttpGovernanceRoleChecker(baseUrl: string): GovernanceRoleChecker {
  return {
    async hasActiveRole(citizenId, roleType) {
      try {
        const res = await fetch(
          `${baseUrl}/governance-roles/roles?citizen_id=${encodeURIComponent(citizenId)}&role_type=${encodeURIComponent(roleType)}`,
        );
        if (!res.ok) return false;
        const roles = (await res.json()) as GovernanceRoleRow[];
        const now = new Date();
        return roles.some((role) => isRoleActive(role, now));
      } catch {
        return false;
      }
    },
  };
}

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). Every propose/endorse/activate/revoke event this service emits
// (ADR-025/ARCH-024 §4-5) maps to TBL-034's admin_action bucket -- none of
// TBL-034's other buckets (rule_change, identity_action, vote_cast, etc.)
// fit a policy-engine grant/revoke event, unlike governance-role-service's
// protocol_change.executed, which has its own dedicated bucket.
// Fire-and-forget per the AuditEmitter contract, same as every other
// cross-service notification in this codebase: a downed NATS/audit-service
// must never block the governance action that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    emit(event, payload) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: "admin_action",
        actor_ref: "iam-service",
        payload: { event, ...payload },
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}
