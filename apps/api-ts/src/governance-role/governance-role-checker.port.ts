// Cross-module port implemented by GovernanceRoleService, consumed by
// project-service and iam-service (the next two phases): AUTH-010's
// approval:submit:operator/:council rows and any future "does this actor
// currently hold a live operator/platform_operator/auditor/oversight/
// review_body role" check resolve through this rather than duplicating
// governance-role's term-window logic in every consumer -- mirrors
// jurisdiction-membership.port.ts's shape/style. All services share one
// app/database (ADR-027/028), so this is an ordinary in-process Nest import
// (GovernanceRoleModule exports this token), not an HTTP seam.
export const GOVERNANCE_ROLE_CHECKER = Symbol("GOVERNANCE_ROLE_CHECKER");

export interface GovernanceRoleChecker {
  // True iff citizenId holds a governance_role row of this roleType with
  // today within [term_start, term_end] -- the exact predicate
  // approval_own_role_insert's RLS EXISTS check enforces at the DB layer
  // (minus the roleType filter, which the RLS policy doesn't need since it
  // already knows the specific approver_role_id being inserted against), so
  // this port and the RLS policy stay provably in sync. roleType is a plain
  // string (one of TBL-032's six governance_role_type values) rather than
  // GovernanceRoleType, so consumers don't need to import this module's
  // internal enum type.
  isActiveHolder(citizenId: string, roleType: string): Promise<boolean>;
}
