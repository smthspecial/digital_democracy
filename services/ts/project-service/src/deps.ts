import type { Store } from "./store.js";
import type {
  AuditEmitter,
  AssignmentRequester,
  LedgerRecorder,
  ProposalAuthorLookup,
  ReputationEmitter,
} from "./integrations.js";

export interface Deps {
  store: Store;
  auditEmitter: AuditEmitter;
  assignmentRequester: AssignmentRequester;
  ledgerRecorder: LedgerRecorder;
  proposalAuthorLookup: ProposalAuthorLookup;
  reputationEmitter: ReputationEmitter;
}
