import { Inject, Injectable } from "@nestjs/common";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { APPROVAL_GATE, type ApprovalGateChecker } from "../governance-role/approval-gate.port.js";
import { GOVERNANCE_ROLE_CHECKER } from "../governance-role/governance-role-checker.port.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { identityRevocationsExecutedTotal } from "../metrics/metrics.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { Citizen, IdentityRevocation, IdentityRevocationReason } from "./identity.types.js";
import { SESSION_REVOKER, type SessionRevoker } from "./session-revoker.port.js";

export interface RequestRevocationInput {
  citizenId: string;
  reason: IdentityRevocationReason;
  justification: string;
}

function actionRefFor(citizenId: string): string {
  return `identity:revoke:${citizenId}`;
}

// US-004/FR-007/ADR-034: the citizen-scoped revocation path -- distinct
// from IamService.revoke (policy/attachment, unilateral by design, ADR-034
// D2). request() records a pending revocation against the approval gate
// (E1-08's 2-of-2 ApprovalGateChecker); execute() only ever moves
// citizen.status to revoked once that gate reports fully approved --
// fail-closed, no path around it.
@Injectable()
export class IdentityRevocationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GOVERNANCE_ROLE_CHECKER) private readonly governanceRole: GovernanceRoleChecker,
    @Inject(APPROVAL_GATE) private readonly approvalGate: ApprovalGateChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
    @Inject(SESSION_REVOKER) private readonly sessionRevoker: SessionRevoker,
  ) {}

  // ADR-034 D4: "identity registrar" maps to the operator role -- the
  // approval gate, not the requester's title, carries FR-007's guarantee.
  async request(actorId: string, input: RequestRevocationInput): Promise<IdentityRevocation> {
    const isOperator = await this.governanceRole.isActiveHolder(actorId, "operator");
    if (!isOperator) {
      throw new ForbiddenDomainError("Only an active operator may request an identity revocation");
    }
    const citizen = await this.prisma.forWorker((tx) => tx.citizen.findUnique({ where: { id: input.citizenId } }));
    if (!citizen) {
      throw new NotFoundDomainError("citizen", input.citizenId);
    }
    if (citizen.status === "revoked") {
      throw new InvalidStateDomainError(`Citizen ${input.citizenId} is already revoked`);
    }
    return this.prisma.forWorker((tx) =>
      tx.identityRevocation.create({
        data: {
          citizenId: input.citizenId,
          reason: input.reason,
          justification: input.justification,
          actionRef: actionRefFor(input.citizenId),
        },
      }),
    );
  }

  // ADR-034 D1, via E1-08's ApprovalGateService: fails closed on anything
  // short of the real 2-of-2 (audit_confirmation + body_endorsement, from
  // distinct citizens holding distinct role types).
  async execute(actionRef: string): Promise<Citizen> {
    const revocation = await this.prisma.app.identityRevocation.findUnique({ where: { actionRef } });
    if (!revocation) {
      throw new NotFoundDomainError("identityRevocation", actionRef);
    }
    if (revocation.status !== "pending") {
      throw new InvalidStateDomainError(`Revocation ${actionRef} is ${revocation.status}, not pending`);
    }
    const approved = await this.approvalGate.isFullyApproved(actionRef);
    if (!approved) {
      throw new InvalidStateDomainError(`Revocation ${actionRef} has not received the required 2-of-2 approval`);
    }

    return this.prisma.forWorker(async (tx) => {
      await tx.identityRevocation.update({
        where: { actionRef },
        data: { status: "executed", executedAt: new Date() },
      });
      const citizen = await tx.citizen.update({ where: { id: revocation.citizenId }, data: { status: "revoked" } });
      await this.audit.emit({
        actionType: "identity.citizen_revoked",
        actorRef: revocation.citizenId,
        payload: { citizenId: revocation.citizenId, reason: revocation.reason, actionRef },
      });
      identityRevocationsExecutedTotal.inc();
      // DP-042 cascade (E1-10): best-effort, never blocks -- citizen.status
      // is already committed above regardless of delivery.
      await this.sessionRevoker.revokeAll(revocation.citizenId);
      return citizen;
    });
  }

  async findByActionRef(actionRef: string): Promise<IdentityRevocation> {
    const revocation = await this.prisma.app.identityRevocation.findUnique({ where: { actionRef } });
    if (!revocation) {
      throw new NotFoundDomainError("identityRevocation", actionRef);
    }
    return revocation;
  }
}
