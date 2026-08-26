import type {
  AuditEmitter,
  COIChecker,
  NotificationEmitter,
  ProtocolChangeExecutor,
  ProtocolGateChecker,
  ReplacementRequester,
} from "./collaborators.js";
import type { Store } from "./store.js";

export interface Deps {
  store: Store;
  protocolGateChecker: ProtocolGateChecker;
  coiChecker: COIChecker;
  protocolChangeExecutor: ProtocolChangeExecutor;
  notificationEmitter: NotificationEmitter;
  replacementRequester: ReplacementRequester;
  auditEmitter: AuditEmitter;
}
