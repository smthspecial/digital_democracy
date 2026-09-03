import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";
import type { Citizen } from "./domain/types.js";

// SRV-001 depends on governance-role-service's multi-approval workflow
// (DP-023 -> DP-035) and audit-service's audit.append (DP-036), neither of
// which exists as a callable service yet. Both are modeled as small
// injectable seams with fakes wired in by buildServer()'s defaults, so real
// implementations can be swapped in later without touching call sites.
//
// actionType is threaded through (ARCH-010 EC-7) so a real backing check can
// scope its answer to the specific action -- without it, a fully-approved
// suspend would also read as an approved revoke for the same citizen. The
// return type allows a plain boolean (the permissive default, and every
// existing sync test double) alongside a real async HTTP call.
export interface ApprovalGate {
  hasRequiredApprovals(citizenId: string, actionType: "suspend" | "revoke"): boolean | Promise<boolean>;
}

export interface AuditEvent {
  entity: "citizen" | "identity_verification";
  entityId: string;
  action: string;
  occurredAt: Date;
}

export interface AuditEmitter {
  append(event: AuditEvent): void;
}

export interface DuplicateSignal {
  matches(citizenA: Citizen, citizenB: Citizen): boolean;
}

export interface IdentityHasher {
  hash(rawLegalIdentifier: string): string;
}

// SessionRevoker models DP-042's cascade into auth-service: suspending or
// revoking a citizen must also terminate their active sessions, or the
// citizen keeps a live, usable session until it naturally expires despite
// no longer being eligible to hold one (SRV-017's `revoke_all_sessions`
// endpoint exists specifically "consumed only by identity-service"). Fire-
// and-forget, matching AuditEmitter's contract: a downed auth-service must
// not block the status change and audit record that triggered it.
export interface SessionRevoker {
  revokeAllSessions(citizenId: string): void;
}

export function createNoopSessionRevoker(): SessionRevoker {
  return { revokeAllSessions: () => {} };
}

// createHttpSessionRevoker calls auth-service's real DP-042 endpoint
// (SRV-017, POST /auth/internal/revoke-all/:citizenId).
export function createHttpSessionRevoker(baseUrl: string): SessionRevoker {
  return {
    revokeAllSessions(citizenId) {
      fetch(`${baseUrl}/auth/internal/revoke-all/${encodeURIComponent(citizenId)}`, {
        method: "POST",
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}

export function createDefaultApprovalGate(): ApprovalGate {
  return { hasRequiredApprovals: () => true };
}

// createHttpApprovalGate calls governance-role-service's real DP-035 status
// endpoint (SRV-011, GET /governance-roles/actions/:actionRef/status),
// scoping the check with this doc's identity:{suspend|revoke}:{citizenId}
// action_ref convention (ARCH-010 EC-7) so a suspend approval can never
// satisfy a revoke check on the same citizen or vice versa.
//
// Fails closed (ARCH-010 EC-16): an unreachable governance-role-service, a
// non-2xx response, or a malformed body all return `false` rather than
// defaulting to approved -- a fail-open default here would silently defeat
// FR-007's no-unilateral-disable guarantee.
export function createHttpApprovalGate(baseUrl: string): ApprovalGate {
  return {
    async hasRequiredApprovals(citizenId, actionType) {
      const actionRef = `identity:${actionType}:${citizenId}`;
      try {
        const res = await fetch(`${baseUrl}/governance-roles/actions/${encodeURIComponent(actionRef)}/status`);
        if (!res.ok) return false;
        const body = (await res.json()) as { fully_approved?: boolean };
        return body.fully_approved === true;
      } catch {
        return false;
      }
    },
  };
}

export function createNoopAuditEmitter(): AuditEmitter {
  return { append: () => {} };
}

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue (ADR-023).
// Every citizen-lifecycle event this service emits (registered, verified,
// activated, suspended, revoked) maps to TBL-034's `identity_event`
// action_type -- the bucket that enum reserves for exactly this service's
// events. Fire-and-forget per the AuditEmitter contract, same as every
// other cross-service notification in this codebase: a downed
// NATS/audit-service must never block the status change or verification
// that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return {
    append(event) {
      void publish(bus, AUDIT_APPEND_SUBJECT, {
        action_type: "identity_event",
        actor_ref: "identity-service",
        payload: {
          entity: event.entity,
          entityId: event.entityId,
          action: event.action,
          occurredAt: event.occurredAt.toISOString(),
        },
        idempotency_key: randomUUID(),
      }).catch(() => {
        // Intentionally swallowed -- see contract note above.
      });
    },
  };
}

function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export function createDefaultDuplicateSignal(): DuplicateSignal {
  return {
    matches: (citizenA, citizenB) =>
      normalizeHandle(citizenA.publicHandle) === normalizeHandle(citizenB.publicHandle),
  };
}

// legal_identity_hash must be deterministic for a given raw identifier so
// exact-duplicate detection (DP-001, DP-024, DP-056) can compare hashes for
// equality; a random per-citizen salt would defeat that, so this keys a
// single per-install pepper via HMAC-SHA256 instead. The pepper lives only
// in memory for the life of the process and is never persisted or logged.
export function createDefaultIdentityHasher(pepper: Buffer = randomBytes(32)): IdentityHasher {
  return {
    hash: (rawLegalIdentifier) =>
      createHmac("sha256", pepper).update(rawLegalIdentifier.trim()).digest("hex"),
  };
}
