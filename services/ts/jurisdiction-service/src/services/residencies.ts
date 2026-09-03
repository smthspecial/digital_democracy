import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { Residency } from "../domain/types.js";
import { validation } from "../errors.js";
import type { AuditEmitter } from "./interfaces.js";

export interface CreateResidencyInput {
  citizen_id: string;
  jurisdiction_id: string;
  start_date: Date;
  end_date: Date | null;
}

// ARCH-011 EC-36: residency creation is a structural change per SRV-002's
// "emits to audit-service on any structural change" rule, same as
// jurisdiction creation/scope-level changes -- it just didn't call the
// AuditEmitter seam at all until now.
export function createResidency(store: Store, audit: AuditEmitter, input: CreateResidencyInput): Residency {
  if (!store.jurisdictions.getById(input.jurisdiction_id)) {
    throw validation("jurisdiction not found");
  }
  if (input.end_date !== null && input.end_date < input.start_date) {
    throw validation("end_date must not be before start_date");
  }
  const residency: Residency = {
    id: randomUUID(),
    citizen_id: input.citizen_id,
    jurisdiction_id: input.jurisdiction_id,
    start_date: input.start_date,
    end_date: input.end_date,
    verified: true, // no residency-verification pipeline exists yet; simplification
    status: input.end_date !== null ? "ended" : "active",
  };
  store.residencies.insert(residency);
  audit("residency.created", { residency_id: residency.id, jurisdiction_id: residency.jurisdiction_id });
  return residency;
}

export function isResidencyCurrentAt(residency: Residency, at: Date): boolean {
  return residency.start_date <= at && (residency.end_date === null || at <= residency.end_date);
}

export function verifyResidency(
  store: Store,
  citizenId: string,
  jurisdictionId: string,
  at: Date,
): boolean {
  return store.residencies
    .listByCitizenAndJurisdiction(citizenId, jurisdictionId)
    .some((r) => isResidencyCurrentAt(r, at));
}
