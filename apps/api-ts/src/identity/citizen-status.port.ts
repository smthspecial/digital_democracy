// Cross-module port implemented by IdentityService, consumed by
// ProblemModule and ProposalModule: AUTH-010 gates nearly every
// citizen-facing write in this pass behind a `citizen.active` condition
// (problem:create, proposal:create, proposal:constraint:add,
// proposal:budget:add, scope_challenge:file), so rather than duplicate a
// citizen lookup in every other module, IdentityModule exports this one
// check. In-process (all four services share one app/database, ADR-027/028).
export const CITIZEN_STATUS_CHECKER = Symbol("CITIZEN_STATUS_CHECKER");

export interface CitizenStatusChecker {
  isActive(citizenId: string): Promise<boolean>;
}
