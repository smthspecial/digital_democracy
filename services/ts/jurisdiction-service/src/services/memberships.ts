import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { Membership } from "../domain/types.js";
import { conflict, validation } from "../errors.js";
import type { AuditEmitter } from "./interfaces.js";

export interface CreateMembershipInput {
  citizen_id: string;
  jurisdiction_id: string;
}

// ARCH-011 EC-36: membership creation is a structural change per SRV-002's
// "emits to audit-service on any structural change" rule, same as
// jurisdiction creation/scope-level changes -- it just didn't call the
// AuditEmitter seam at all until now.
export function createMembership(store: Store, audit: AuditEmitter, input: CreateMembershipInput): Membership {
  if (!store.jurisdictions.getById(input.jurisdiction_id)) {
    throw validation("jurisdiction not found");
  }
  // Unique on (citizen_id, jurisdiction_id): a citizen may belong to many
  // nested jurisdictions simultaneously, but not twice to the same one.
  if (store.memberships.find(input.citizen_id, input.jurisdiction_id)) {
    throw conflict("membership already exists for this citizen and jurisdiction");
  }
  const membership: Membership = {
    id: randomUUID(),
    citizen_id: input.citizen_id,
    jurisdiction_id: input.jurisdiction_id,
    created_at: new Date(),
  };
  store.memberships.insert(membership);
  audit("membership.created", { membership_id: membership.id, jurisdiction_id: membership.jurisdiction_id });
  return membership;
}

export function listMemberships(store: Store, citizenId: string): Membership[] {
  return store.memberships.listByCitizen(citizenId);
}
