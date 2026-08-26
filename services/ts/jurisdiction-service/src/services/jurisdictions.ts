import { randomUUID } from "node:crypto";
import type { Store } from "../store.js";
import type { Jurisdiction, ScopeLevel } from "../domain/types.js";
import { forbidden, notFound, validation } from "../errors.js";
import type { ApprovalGate, AuditEmitter } from "./interfaces.js";

export interface CreateJurisdictionInput {
  parent_id: string | null;
  name: string;
  scope_level: ScopeLevel;
  boundary_ref: string;
}

export function createJurisdiction(
  store: Store,
  audit: AuditEmitter,
  input: CreateJurisdictionInput,
): Jurisdiction {
  if (input.parent_id !== null && !store.jurisdictions.getById(input.parent_id)) {
    throw validation("parent jurisdiction not found");
  }
  const jurisdiction: Jurisdiction = {
    id: randomUUID(),
    parent_id: input.parent_id,
    name: input.name,
    scope_level: input.scope_level,
    boundary_ref: input.boundary_ref,
    status: "active",
  };
  store.jurisdictions.insert(jurisdiction);
  audit("jurisdiction.created", { jurisdiction_id: jurisdiction.id });
  return jurisdiction;
}

export interface JurisdictionTreeNode extends Jurisdiction {
  children: JurisdictionTreeNode[];
}

function buildNode(store: Store, jurisdiction: Jurisdiction): JurisdictionTreeNode {
  return {
    ...jurisdiction,
    children: store.jurisdictions.listChildren(jurisdiction.id).map((child) => buildNode(store, child)),
  };
}

export function getJurisdictionTree(store: Store, id: string): JurisdictionTreeNode {
  const root = store.jurisdictions.getById(id);
  if (!root) throw notFound("jurisdiction not found");
  return buildNode(store, root);
}

export function changeScopeLevel(
  store: Store,
  approvalGate: ApprovalGate,
  audit: AuditEmitter,
  id: string,
  scopeLevel: ScopeLevel,
): Jurisdiction {
  const jurisdiction = store.jurisdictions.getById(id);
  if (!jurisdiction) throw notFound("jurisdiction not found");
  if (!approvalGate(id)) throw forbidden("scope-level change requires protocol-layer approval");
  const updated: Jurisdiction = { ...jurisdiction, scope_level: scopeLevel };
  store.jurisdictions.update(updated);
  audit("jurisdiction.scope_level_changed", { jurisdiction_id: id, scope_level: scopeLevel });
  return updated;
}

function collectDescendantIds(store: Store, id: string): string[] {
  return store.jurisdictions
    .listChildren(id)
    .flatMap((child) => [child.id, ...collectDescendantIds(store, child.id)]);
}

export function collectSelfAndDescendantIds(store: Store, id: string): string[] {
  return [id, ...collectDescendantIds(store, id)];
}
