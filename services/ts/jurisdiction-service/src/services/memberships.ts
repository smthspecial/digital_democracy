import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { Membership } from "../domain/types.js";
import { conflict, validation } from "../errors.js";

export interface CreateMembershipInput {
  citizen_id: string;
  jurisdiction_id: string;
}

export function createMembership(store: Store, input: CreateMembershipInput): Membership {
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
  return membership;
}

export function listMemberships(store: Store, citizenId: string): Membership[] {
  return store.memberships.listByCitizen(citizenId);
}
