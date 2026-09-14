// Cross-module port implemented by ProposalService, consumed by
// ProblemModule after a successful DP-004 endorsement (in-process call, same
// app/database -- ADR-027/028; see ADR-030's "DP-028 only, not DP-029" note).
export const PROPOSAL_SUPPORT_RECOMPUTER = Symbol("PROPOSAL_SUPPORT_RECOMPUTER");

export interface ProposalSupportRecomputer {
  // DP-028: recompute `support_count` on every proposal linked to this
  // problem from the problem's current `problem_support` row count. Pure
  // recompute -- does not transition `status` (DP-029's transitions are out
  // of scope; see ADR-030).
  recomputeForProblem(problemId: string): Promise<void>;
}
