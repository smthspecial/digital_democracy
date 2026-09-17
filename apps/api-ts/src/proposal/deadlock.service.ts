import { Inject, Injectable } from "@nestjs/common";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { GOVERNANCE_ROLE_CHECKER } from "../governance-role/governance-role-checker.port.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { DeadlockHistoryEntry, DeadlockStage, Proposal } from "./proposal.types.js";

export const DEADLOCK_STAGES: readonly DeadlockStage[] = [
  "constraint_analysis",
  "alternative_generation",
  "resource_partitioning",
  "compensation_assessment",
  "citizen_assembly_review",
  "escalation_review",
  "constitutional_review",
  "final_decision",
];

// FR-034/ADR-036 D35/E5-13..15: the eight-stage deadlock framework -- zero
// code before this (the audit's grep for "deadlock" returned nothing
// repo-wide). Reviewer authority is the same civic_assignment(type=
// proposal_review, targetRef=proposalId) mechanism deliberation's
// lockArgument uses (D35: one authority helper for both features -- this
// is that shared check, duplicated rather than abstracted across two
// otherwise-independent modules for now).
@Injectable()
export class DeadlockService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_ROLE_CHECKER) private readonly governanceRole: GovernanceRoleChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  private async assertReviewer(reviewerId: string, proposalId: string): Promise<void> {
    const assignment = await this.prisma.forWorker((tx) =>
      tx.civicAssignment.findFirst({
        where: { citizenId: reviewerId, type: "proposal_review", targetRef: proposalId, status: "assigned" },
      }),
    );
    if (!assignment) {
      throw new ForbiddenDomainError("Deadlock actions require an active proposal_review assignment for this proposal");
    }
  }

  private async getProposalOrThrow(proposalId: string): Promise<Proposal> {
    const proposal = await this.prisma.app.proposal.findUnique({ where: { id: proposalId } });
    if (!proposal) {
      throw new NotFoundDomainError("proposal", proposalId);
    }
    return proposal;
  }

  // Entry is not repeatable -- a proposal already in the deadlock track
  // cannot re-enter.
  async enter(reviewerId: string, proposalId: string, notes: string): Promise<Proposal> {
    const proposal = await this.getProposalOrThrow(proposalId);
    if (proposal.deadlockActive) {
      throw new InvalidStateDomainError(`Proposal ${proposalId} is already in the deadlock track`);
    }
    await this.assertReviewer(reviewerId, proposalId);

    return this.prisma.forWorker(async (tx) => {
      const updated = await tx.proposal.update({
        where: { id: proposalId },
        data: { deadlockActive: true, deadlockStage: DEADLOCK_STAGES[0] },
      });
      await tx.deadlockHistoryEntry.create({
        data: { proposalId, stage: DEADLOCK_STAGES[0], reviewerId, notes },
      });
      return updated;
    });
  }

  // Requires prior entry, an assigned reviewer, and notes on every step.
  async advance(reviewerId: string, proposalId: string, notes: string): Promise<Proposal> {
    const proposal = await this.getProposalOrThrow(proposalId);
    if (!proposal.deadlockActive || proposal.deadlockStage === null) {
      throw new InvalidStateDomainError(`Proposal ${proposalId} is not in the deadlock track`);
    }
    if (proposal.deadlockStage === "final_decision") {
      throw new InvalidStateDomainError(`Proposal ${proposalId} is already at final_decision; use conclude()`);
    }
    if (!notes.trim()) {
      throw new InvalidStateDomainError("Advancing a deadlock stage requires notes");
    }
    await this.assertReviewer(reviewerId, proposalId);

    const nextStage = DEADLOCK_STAGES[DEADLOCK_STAGES.indexOf(proposal.deadlockStage) + 1];
    return this.prisma.forWorker(async (tx) => {
      const updated = await tx.proposal.update({ where: { id: proposalId }, data: { deadlockStage: nextStage } });
      await tx.deadlockHistoryEntry.create({ data: { proposalId, stage: nextStage, reviewerId, notes } });
      return updated;
    });
  }

  // Only from final_decision -- guarantees a terminal outcome (never leaves
  // the track indefinitely open) and sets the proposal's outcome status.
  async conclude(reviewerId: string, proposalId: string, outcome: "approved" | "rejected", notes: string): Promise<Proposal> {
    const proposal = await this.getProposalOrThrow(proposalId);
    if (!proposal.deadlockActive || proposal.deadlockStage !== "final_decision") {
      throw new InvalidStateDomainError(`Proposal ${proposalId} must reach final_decision before concluding`);
    }
    await this.assertReviewer(reviewerId, proposalId);

    return this.prisma.forWorker(async (tx) => {
      const updated = await tx.proposal.update({
        where: { id: proposalId },
        data: { deadlockActive: false, status: outcome },
      });
      await tx.deadlockHistoryEntry.create({ data: { proposalId, stage: "final_decision", reviewerId, notes } });
      await this.audit.emit({
        actionType: "proposal.status_changed",
        actorRef: reviewerId,
        payload: { proposalId, event: "deadlock_concluded", outcome },
      });
      return updated;
    });
  }

  async history(proposalId: string): Promise<DeadlockHistoryEntry[]> {
    return this.prisma.app.deadlockHistoryEntry.findMany({ where: { proposalId }, orderBy: { at: "asc" } });
  }
}
