import { randomUUID } from "node:crypto";
import { publish, type EventBus } from "@dd/event-bus";

// DP-035: scope-level changes require protocol-layer approval coordinated by
// governance-role-service. The return type allows a plain boolean (this
// permissive default, and every existing sync test double) alongside a real
// async HTTP call.
export type ApprovalGate = (jurisdictionId: string) => boolean | Promise<boolean>;
export const defaultApprovalGate: ApprovalGate = () => true;

// createHttpApprovalGate calls governance-role-service's real DP-035 status
// endpoint (SRV-011, GET /governance-roles/actions/:actionRef/status),
// scoping the check to this jurisdiction with the
// `jurisdiction:scope-level:{jurisdictionId}` action_ref convention (the
// same pattern ARCH-010's identity:{suspend|revoke}:{citizenId} convention
// established for identity-service's ApprovalGate).
//
// Fails closed (ARCH-011 EC-31, symmetric with ARCH-010 EC-16): an
// unreachable governance-role-service, a non-2xx response, or a malformed
// body all return `false` rather than defaulting to approved.
export function createHttpApprovalGate(baseUrl: string): ApprovalGate {
  return async (jurisdictionId: string) => {
    const actionRef = `jurisdiction:scope-level:${jurisdictionId}`;
    try {
      const res = await fetch(`${baseUrl}/governance-roles/actions/${encodeURIComponent(actionRef)}/status`);
      if (!res.ok) return false;
      const body = (await res.json()) as { fully_approved?: boolean };
      return body.fully_approved === true;
    } catch {
      return false;
    }
  };
}

// DP-036: structural changes are appended to the hash-chained audit log.
export type AuditEmitter = (eventType: string, payload: Record<string, unknown>) => void;
export const noopAuditEmitter: AuditEmitter = () => {};

// The audit.append queue's subject and stream name (DP-036, ADR-023).
// audit-service's own consumer (services/go/audit-service/nats.go) binds
// to this same stream/subject pair.
export const AUDIT_APPEND_STREAM = "AUDIT";
export const AUDIT_APPEND_SUBJECT = "audit.append";

// createNatsAuditEmitter publishes to the real audit.append queue
// (ADR-023). Every event this service emits (jurisdiction creation,
// scope-level changes, residency/membership creation) is a structural
// change to jurisdiction data with no more specific TBL-034 bucket, so all
// of them map to admin_action, same convention as
// governance-role-service's AuditEmitter. Fire-and-forget per the
// AuditEmitter contract, same as every other cross-service notification in
// this codebase: a downed NATS/audit-service must never block the
// structural change that triggered it.
export function createNatsAuditEmitter(bus: EventBus): AuditEmitter {
  return (eventType, payload) => {
    void publish(bus, AUDIT_APPEND_SUBJECT, {
      action_type: "admin_action",
      actor_ref: "jurisdiction-service",
      payload: { event_type: eventType, ...payload },
      idempotency_key: randomUUID(),
    }).catch(() => {
      // Intentionally swallowed -- see contract note above.
    });
  };
}
