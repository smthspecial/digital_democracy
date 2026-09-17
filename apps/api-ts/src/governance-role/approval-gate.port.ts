export const APPROVAL_GATE = Symbol("APPROVAL_GATE");

export interface ApprovalGateChecker {
  isFullyApproved(actionRef: string): Promise<boolean>;
}
