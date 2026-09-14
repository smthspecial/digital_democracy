// Cross-module port implemented by JurisdictionService, consumed by
// ProblemModule (DP-004's `jurisdiction:member` condition) and ProposalModule
// (DP-020's `jurisdiction:affected` condition) -- AUTH-010 scope types that
// need jurisdiction-service's own tables (residency, jurisdiction_membership)
// to resolve. All four services share one app/database (ADR-027/028), so
// this is an ordinary in-process Nest import (JurisdictionModule exports
// this token), not an HTTP seam -- ARCH-023 §5's "no, resolve over HTTP"
// guidance predates that collapse and assumed per-service databases; the
// call shape it prescribes (resolve the scope before writing) is kept, only
// the transport changed from HTTP to an in-process call.
export const JURISDICTION_MEMBERSHIP_CHECKER = Symbol("JURISDICTION_MEMBERSHIP_CHECKER");

export interface JurisdictionMembershipChecker {
  // Strict: citizen holds a `jurisdiction_membership` row for this exact
  // jurisdiction. Used for problem:endorse's `jurisdiction:member` (AUTH-010).
  isMember(citizenId: string, jurisdictionId: string): Promise<boolean>;

  // Broader: member OR a verified resident of this jurisdiction (the same
  // notion JurisdictionService's own eligibility check uses). Used for
  // scope_challenge:file's `jurisdiction:affected` (AUTH-010) -- named
  // distinctly from `isMember` in AUTH-010, so given a distinct, broader
  // definition here rather than collapsing the two.
  isAffected(citizenId: string, jurisdictionId: string): Promise<boolean>;
}
