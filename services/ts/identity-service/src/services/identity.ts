import { randomUUID } from "node:crypto";
import type { Citizen, IdentityVerification, VerificationMethod } from "../domain/types.js";
import type { Store } from "../store.js";
import type {
  ApprovalGate,
  AuditEmitter,
  DuplicateSignal,
  IdentityHasher,
  SessionRevoker,
} from "../collaborators.js";
import { conflict, forbidden, notFound } from "../errors.js";

export interface IdentityServiceDeps {
  store: Store;
  hasher: IdentityHasher;
  approvalGate: ApprovalGate;
  audit: AuditEmitter;
  duplicateSignal: DuplicateSignal;
  sessionRevoker: SessionRevoker;
}

export interface RegisterCitizenInput {
  publicHandle: string;
  rawLegalIdentifier: string;
}

export function registerCitizen(deps: IdentityServiceDeps, input: RegisterCitizenInput): Citizen {
  const legalIdentityHash = deps.hasher.hash(input.rawLegalIdentifier);
  if (deps.store.findCitizenByLegalHash(legalIdentityHash)) {
    throw conflict("An identity already exists for this legal identifier");
  }

  const citizen: Citizen = {
    id: randomUUID(),
    publicHandle: input.publicHandle,
    legalIdentityHash,
    status: "pending",
    createdAt: new Date(),
  };
  deps.store.insertCitizen(citizen);
  deps.audit.append({
    entity: "citizen",
    entityId: citizen.id,
    action: "registered",
    occurredAt: citizen.createdAt,
  });
  return citizen;
}

export function getCitizen(deps: IdentityServiceDeps, citizenId: string): Citizen {
  const citizen = deps.store.getCitizen(citizenId);
  if (!citizen) throw notFound("Citizen not found");
  return citizen;
}

export function listCitizens(deps: IdentityServiceDeps): Citizen[] {
  return deps.store.listCitizens();
}

export interface SubmitVerificationInput {
  evidenceRef: string;
  outcome: "verified" | "rejected";
  method?: VerificationMethod;
}

export function submitVerification(
  deps: IdentityServiceDeps,
  citizenId: string,
  input: SubmitVerificationInput,
): IdentityVerification {
  const citizen = getCitizen(deps, citizenId);
  const now = new Date();

  const verification: IdentityVerification = {
    id: randomUUID(),
    citizenId,
    method: input.method ?? "gov_credential",
    evidenceRef: input.evidenceRef,
    status: input.outcome,
    verifiedAt: input.outcome === "verified" ? now : null,
  };
  deps.store.insertVerification(verification);
  deps.audit.append({
    entity: "identity_verification",
    entityId: verification.id,
    action: input.outcome,
    occurredAt: now,
  });

  // Only the first verified record activates a citizen; later verified (or
  // rejected) records never re-trigger activation once already active.
  if (input.outcome === "verified" && citizen.status === "pending") {
    deps.store.updateCitizenStatus(citizenId, "active");
    deps.audit.append({ entity: "citizen", entityId: citizenId, action: "activated", occurredAt: now });
  }

  return verification;
}

export async function suspendCitizen(deps: IdentityServiceDeps, citizenId: string): Promise<Citizen> {
  const current = getCitizen(deps, citizenId);
  // ARCH-010 EC-4: a fully-approved re-suspend of an already-suspended or
  // already-revoked citizen must not silently overwrite the stronger
  // `revoked` status back to `suspended` (or no-op-reapply `suspended`).
  if (current.status === "suspended" || current.status === "revoked") {
    throw conflict(`cannot suspend a citizen with status ${current.status}`);
  }
  if (!(await deps.approvalGate.hasRequiredApprovals(citizenId, "suspend"))) {
    throw forbidden("Suspension requires multi-approval");
  }
  const citizen = deps.store.updateCitizenStatus(citizenId, "suspended");
  if (!citizen) throw notFound("Citizen not found");
  deps.audit.append({ entity: "citizen", entityId: citizenId, action: "suspended", occurredAt: new Date() });
  // A suspended citizen must not keep using an already-issued session until
  // it naturally expires (DP-042 cascade into auth-service).
  deps.sessionRevoker.revokeAllSessions(citizenId);
  return citizen;
}

export async function revokeCitizen(deps: IdentityServiceDeps, citizenId: string): Promise<Citizen> {
  const current = getCitizen(deps, citizenId);
  // ARCH-010 EC-4: revocation is terminal -- a replayed or re-approved
  // revoke against an already-revoked citizen must reject, not re-fire the
  // audit trail and session cascade for a transition that already happened.
  if (current.status === "revoked") {
    throw conflict("citizen is already revoked");
  }
  if (!(await deps.approvalGate.hasRequiredApprovals(citizenId, "revoke"))) {
    throw forbidden("Revocation requires multi-approval");
  }
  const citizen = deps.store.updateCitizenStatus(citizenId, "revoked");
  if (!citizen) throw notFound("Citizen not found");
  // DP-042's remaining cascade (delegations, assignments, tokens, governance
  // roles) is owned by other services; this boundary flips status, audits,
  // and terminates the citizen's live sessions so revocation takes effect
  // immediately rather than only once auth-service's own session TTL lapses.
  deps.audit.append({ entity: "citizen", entityId: citizenId, action: "revoked", occurredAt: new Date() });
  deps.sessionRevoker.revokeAllSessions(citizenId);
  return citizen;
}

export interface DuplicateHashGroup {
  legalIdentityHash: string;
  citizenIds: string[];
}

export interface DuplicateSignalMatch {
  citizenIdA: string;
  citizenIdB: string;
}

export interface DuplicateScanResult {
  hashMatches: DuplicateHashGroup[];
  signalMatches: DuplicateSignalMatch[];
}

export function scanForDuplicates(deps: IdentityServiceDeps): DuplicateScanResult {
  const citizens = deps.store.listCitizens();

  const byHash = new Map<string, string[]>();
  for (const citizen of citizens) {
    const ids = byHash.get(citizen.legalIdentityHash) ?? [];
    ids.push(citizen.id);
    byHash.set(citizen.legalIdentityHash, ids);
  }
  const hashMatches: DuplicateHashGroup[] = [...byHash.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([legalIdentityHash, citizenIds]) => ({ legalIdentityHash, citizenIds }));

  const signalMatches: DuplicateSignalMatch[] = [];
  for (const [i, citizenA] of citizens.entries()) {
    for (const citizenB of citizens.slice(i + 1)) {
      if (citizenA.legalIdentityHash === citizenB.legalIdentityHash) continue;
      if (deps.duplicateSignal.matches(citizenA, citizenB)) {
        signalMatches.push({ citizenIdA: citizenA.id, citizenIdB: citizenB.id });
      }
    }
  }

  if (hashMatches.length > 0 || signalMatches.length > 0) {
    deps.audit.append({
      entity: "citizen",
      entityId: "duplicate-scan",
      action: "duplicates_flagged",
      occurredAt: new Date(),
    });
  }

  return { hashMatches, signalMatches };
}
