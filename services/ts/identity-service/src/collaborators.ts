import { createHmac, randomBytes } from "node:crypto";
import type { Citizen } from "./domain/types.js";

// SRV-001 depends on governance-role-service's multi-approval workflow
// (DP-023 -> DP-035) and audit-service's audit.append (DP-036), neither of
// which exists as a callable service yet. Both are modeled as small
// injectable seams with fakes wired in by buildServer()'s defaults, so real
// implementations can be swapped in later without touching call sites.
export interface ApprovalGate {
  hasRequiredApprovals(citizenId: string): boolean;
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

export function createDefaultApprovalGate(): ApprovalGate {
  return { hasRequiredApprovals: () => true };
}

export function createNoopAuditEmitter(): AuditEmitter {
  return { append: () => {} };
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
