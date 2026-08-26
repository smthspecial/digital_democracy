import { createStore, type Store } from "./store.js";
import {
  defaultApprovalGate,
  noopAuditEmitter,
  type ApprovalGate,
  type AuditEmitter,
} from "./services/interfaces.js";

export interface Deps {
  store: Store;
  approvalGate: ApprovalGate;
  auditEmitter: AuditEmitter;
}

export function createDefaultDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    store: overrides.store ?? createStore(),
    approvalGate: overrides.approvalGate ?? defaultApprovalGate,
    auditEmitter: overrides.auditEmitter ?? noopAuditEmitter,
  };
}
