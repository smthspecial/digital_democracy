import { randomUUID } from "node:crypto";
import type { Citizen, IdentityVerification, VerificationMethod } from "../domain/types.js";
import type { Store } from "../store.js";
import type { ApprovalGate, AuditEmitter, DuplicateSignal, IdentityHasher } from "../collaborators.js";
import { conflict, forbidden, notFound } from "../errors.js";

export interface IdentityServiceDeps {
  store: Store;
  hasher: IdentityHasher;
  approvalGate: ApprovalGate;
  audit: AuditEmitter;
  duplicateSignal: DuplicateSignal;
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

export function suspendCitizen(deps: IdentityServiceDeps, citizenId: string): Citizen {
  getCitizen(deps, citizenId);
  if (!deps.approvalGate.hasRequiredApprovals(citizenId)) {
    throw forbidden("Suspension requires multi-approval");
  }
  const citizen = deps.store.updateCitizenStatus(citizenId, "suspended");
  if (!citizen) throw notFound("Citizen not found");
  deps.audit.append({ entity: "citizen", entityId: citizenId, action: "suspended", occurredAt: new Date() });
  return citizen;
}

export function revokeCitizen(deps: IdentityServiceDeps, citizenId: string): Citizen {
  getCitizen(deps, citizenId);
  if (!deps.approvalGate.hasRequiredApprovals(citizenId)) {
    throw forbidden("Revocation requires multi-approval");
  }
  const citizen = deps.store.updateCitizenStatus(citizenId, "revoked");
  if (!citizen) throw notFound("Citizen not found");
  // DP-042's cascade (delegations, assignments, tokens, governance roles)
  // is owned by other services; this boundary only flips status and audits.
  deps.audit.append({ entity: "citizen", entityId: citizenId, action: "revoked", occurredAt: new Date() });
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
