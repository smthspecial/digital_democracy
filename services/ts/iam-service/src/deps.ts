import type { AuditEmitter, GovernanceRoleChecker } from "./collaborators.js";
import type { Store } from "./store.js";

export interface Deps {
  store: Store;
  governanceRoleChecker: GovernanceRoleChecker;
  auditEmitter: AuditEmitter;
}
