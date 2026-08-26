import type { AuditEmitter } from "../collaborators.js";
import { validation } from "../errors.js";
import type { GovernanceRole } from "../domain/types.js";
import type { CreateRoleInput, RoleFilter, Store } from "../store.js";

export function createRole(
  store: Store,
  auditEmitter: AuditEmitter,
  input: CreateRoleInput,
): GovernanceRole {
  if (input.termEnd.getTime() <= input.termStart.getTime()) {
    throw validation("term_end must be after term_start");
  }

  const role = store.createRole(input);
  auditEmitter.emit("governance_role.created", { roleId: role.id, citizenId: role.citizenId });
  return role;
}

export function listRoles(store: Store, filter: RoleFilter): GovernanceRole[] {
  return store.listRoles(filter);
}
