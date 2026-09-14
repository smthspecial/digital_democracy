import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  CivicAssignment,
  CivicAssignmentListFilter,
  CivicAssignmentStatus,
  ExemptionStatus,
  ParticipationRecord,
  ParticipationRecordListFilter,
} from "./civic-duty.types.js";

const RECORD_NOT_FOUND = "P2025";

export interface ClaimExemptionInput {
  period: string;
  exemptionStatus: ExemptionStatus;
}

// SRV-009: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
// Both civic_assignment and participation_record are ARCH-023 §6 OWN
// (citizen-private).
//
// Neither table has a citizen-facing (or, this pass, worker-facing) INSERT
// path -- DP-040 (assignment generation) and DP-048 (participation scoring)
// are async/cron, out of scope this pass (see schema.prisma's civic-duty
// section comment). Fixtures for tests go in directly via an admin
// connection, mirroring budget_category's precedent.
@Injectable()
export class CivicDutyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // AUTH-010 assignment:accept/assignment:abandon read: own scope, no public
  // read (ARCH-023 §6: civic_assignment is OWN, private participation
  // history, unlike e.g. project's PUBLIC oversight tables).
  //
  // civic_assignment_own_select: forCitizen(citizenId, ...) with citizenId
  // as both the RLS context and the filter target (same forCitizen shape
  // BudgetService.getMyAllocation uses for its own own-row read).
  async listAssignments(citizenId: string, filter?: CivicAssignmentListFilter): Promise<CivicAssignment[]> {
    const rows = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.civicAssignment.findMany({
        where: { citizenId, ...(filter?.status ? { status: filter.status } : {}) },
        orderBy: { assignedAt: "asc" },
      }),
    );
    return rows.map(toCivicAssignment);
  }

  // AUTH-009's combined "Accept / complete civic assignment" row maps to
  // AUTH-010's `assignment:accept` permission (own scope) -- there is no
  // separate `assignment:complete` permission in AUTH-010's canonical list,
  // and TBL-024's status enum has no "offered but not yet accepted" state
  // distinct from 'assigned', so this is the transition that actually
  // completes the review work (a documented AUTH-009/AUTH-010 naming
  // mismatch, mirroring the codebase's existing practice of flagging such
  // gaps rather than silently picking one reading).
  async completeAssignment(citizenId: string, assignmentId: string): Promise<CivicAssignment> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    await this.assertOwnAssignedAssignment(citizenId, assignmentId);
    const updated = await this.updateAssignmentStatus(citizenId, assignmentId, "completed");
    await this.audit.emit({
      actionType: "civic_duty.assignment_completed",
      actorRef: citizenId,
      payload: { assignmentId: updated.id, type: updated.type },
    });
    return updated;
  }

  // AUTH-010 assignment:abandon -- "recorded in participation_record" per
  // AUTH-009, but TBL-025's own column list has no abandonment counter to
  // increment (a spec gap; the abandoned civic_assignment row itself, once
  // DP-048's scoring cron reads it, is the record -- not invented here).
  async abandonAssignment(citizenId: string, assignmentId: string): Promise<CivicAssignment> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    await this.assertOwnAssignedAssignment(citizenId, assignmentId);
    const updated = await this.updateAssignmentStatus(citizenId, assignmentId, "abandoned");
    await this.audit.emit({
      actionType: "civic_duty.assignment_abandoned",
      actorRef: citizenId,
      payload: { assignmentId: updated.id, type: updated.type },
    });
    return updated;
  }

  async listParticipation(citizenId: string, filter?: ParticipationRecordListFilter): Promise<ParticipationRecord[]> {
    const rows = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.participationRecord.findMany({ where: { citizenId, ...(filter?.period ? { period: filter.period } : {}) } }),
    );
    return rows.map(toParticipationRecord);
  }

  // AUTH-010 exemption:claim (own scope). Requires an EXISTING
  // participation_record row for the given period -- DP-048 (the monthly
  // scoring cron that creates one) is out of scope this pass, so unlike
  // every other citizen-facing write in this app, there is deliberately no
  // upsert-a-row-if-missing fallback here: inventing one would silently
  // paper over the real DP-048 dependency this operation has (same "gap
  // documented, not invented" practice as budget_category's worker-only
  // creation path). Also transitions every currently 'assigned' assignment
  // to 'exempted' -- TBL-024's status enum explicitly includes that value,
  // and FR-053 describes exemptions as pausing civic *obligations*, not
  // merely labeling the score row.
  async claimExemption(citizenId: string, input: ClaimExemptionInput): Promise<ParticipationRecord> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    const existing = await this.findParticipationRecord(citizenId, input.period);
    if (!existing) {
      throw new NotFoundDomainError("participation_record for period", input.period);
    }

    const updated = await this.updateExemptionStatus(citizenId, input.period, input.exemptionStatus);
    await this.exemptAssignedAssignments(citizenId);

    // FR-053: "Exemption records are auditable."
    await this.audit.emit({
      actionType: "civic_duty.exemption_claimed",
      actorRef: citizenId,
      payload: { period: input.period, exemptionStatus: input.exemptionStatus },
    });

    return updated;
  }

  // civic_assignment_own_update's USING clause additionally requires the
  // CURRENT row to already be 'assigned' -- checked here first (for an
  // accurate NotFoundDomainError vs InvalidStateDomainError), so a P2025 in
  // updateAssignmentStatus below would only ever indicate a genuine race and
  // is left to propagate as-is rather than remapped.
  private async assertOwnAssignedAssignment(citizenId: string, assignmentId: string): Promise<void> {
    const assignment = await this.findAssignmentById(citizenId, assignmentId);
    if (!assignment) {
      throw new NotFoundDomainError("civic_assignment", assignmentId);
    }
    if (assignment.status !== "assigned") {
      throw new InvalidStateDomainError(`civic assignment ${assignmentId} is not in 'assigned' status`);
    }
  }

  private async findAssignmentById(citizenId: string, id: string): Promise<CivicAssignment | null> {
    const row = await this.prisma.forCitizen(citizenId, (tx) => tx.civicAssignment.findFirst({ where: { id, citizenId } }));
    return row ? toCivicAssignment(row) : null;
  }

  private async updateAssignmentStatus(
    citizenId: string,
    id: string,
    status: CivicAssignmentStatus,
  ): Promise<CivicAssignment> {
    try {
      const row = await this.prisma.forCitizen(citizenId, (tx) =>
        tx.civicAssignment.update({ where: { id }, data: { status } }),
      );
      return toCivicAssignment(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === RECORD_NOT_FOUND) {
        throw new NotFoundDomainError("civic_assignment", id);
      }
      throw err;
    }
  }

  // TBL-024's status enum includes `exempted` -- claiming a general
  // exemption (FR-053) pauses every currently open assignment, not just the
  // participation_record row. Returns the count of assignments transitioned.
  // civic_assignment_own_update's USING clause already restricts this
  // updateMany to rows that are still 'assigned' and owned by this citizen.
  private async exemptAssignedAssignments(citizenId: string): Promise<number> {
    const result = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.civicAssignment.updateMany({ where: { citizenId, status: "assigned" }, data: { status: "exempted" } }),
    );
    return result.count;
  }

  private async findParticipationRecord(citizenId: string, period: string): Promise<ParticipationRecord | null> {
    const row = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.participationRecord.findFirst({ where: { citizenId, period } }),
    );
    return row ? toParticipationRecord(row) : null;
  }

  // participation_record_own_update: exemption:claim (AUTH-010) only ever
  // updates an EXISTING period's row -- see claimExemption's own note above
  // on why no insert path exists here.
  private async updateExemptionStatus(
    citizenId: string,
    period: string,
    exemptionStatus: ExemptionStatus,
  ): Promise<ParticipationRecord> {
    try {
      const row = await this.prisma.forCitizen(citizenId, (tx) =>
        tx.participationRecord.update({
          where: { citizenId_period: { citizenId, period } },
          data: { exemptionStatus },
        }),
      );
      return toParticipationRecord(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === RECORD_NOT_FOUND) {
        throw new NotFoundDomainError("participation_record", period);
      }
      throw err;
    }
  }
}

function toCivicAssignment(row: {
  id: string;
  citizenId: string;
  type: CivicAssignment["type"];
  targetRef: string;
  assignedAt: Date;
  dueAt: Date;
  status: CivicAssignment["status"];
}): CivicAssignment {
  return {
    id: row.id,
    citizenId: row.citizenId,
    type: row.type,
    targetRef: row.targetRef,
    assignedAt: row.assignedAt,
    dueAt: row.dueAt,
    status: row.status,
  };
}

function toParticipationRecord(row: {
  id: string;
  citizenId: string;
  period: string;
  score: Prisma.Decimal;
  quotaTarget: Prisma.Decimal | null;
  exemptionStatus: ParticipationRecord["exemptionStatus"];
  inactivityStage: number;
}): ParticipationRecord {
  return {
    id: row.id,
    citizenId: row.citizenId,
    period: row.period,
    score: row.score.toNumber(),
    quotaTarget: row.quotaTarget === null ? null : row.quotaTarget.toNumber(),
    exemptionStatus: row.exemptionStatus,
    inactivityStage: row.inactivityStage,
  };
}
