import type { Store } from "./store.js";
import type { AuditEmitter, AssignmentRequester } from "./integrations.js";

export interface Deps {
  store: Store;
  auditEmitter: AuditEmitter;
  assignmentRequester: AssignmentRequester;
}
