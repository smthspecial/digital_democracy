import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { NotFoundDomainError } from "../common/domain-errors.js";
import { NOTIFICATION_EMITTER, type NotificationEmitter } from "../common/notification-emitter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ReputationRecorder } from "./reputation-recorder.port.js";
import { RecordDeltaInput, ReputationRecord, ReputationRecordListFilter } from "./reputation.types.js";

const FOREIGN_KEY_VIOLATION = "P2003";

// SRV-014.md doesn't define a magnitude for "significant" -- a judgment
// call, mirroring budget.service.ts's TOTAL_TOLERANCE constant: any single
// delta with absolute value at or above this crosses SRV-014.md's "Emits
// to:... notification-service (DP-039 on significant delta)" threshold.
const SIGNIFICANT_DELTA_THRESHOLD = 5;

// DP-038, SRV-014: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
@Injectable()
export class ReputationService implements ReputationRecorder {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
    @Inject(NOTIFICATION_EMITTER) private readonly notification: NotificationEmitter,
  ) {}

  // Public read (ARCH-023 §6) -- reputation is an informational signal only
  // (FR-027), never gated behind a citizen's own identity.
  // reputation_record_public_read is USING(true) for both roles (ARCH-023
  // §6) -- no citizen context needed, mirrors ProjectService.listProjects.
  async listRecords(filter?: ReputationRecordListFilter): Promise<ReputationRecord[]> {
    const rows = await this.prisma.app.reputationRecord.findMany({
      where: filter?.citizenId ? { citizenId: filter.citizenId } : undefined,
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toReputationRecord);
  }

  // REPUTATION_RECORDER port. DP-038: inserts a signed reputation_record
  // delta row. SRV-014.md's Dependencies section states "Emits to:
  // audit-service (DP-036)" even though DP-038.md's own body text doesn't
  // say so directly -- the same "service-doc states it, DP-doc doesn't"
  // shape as GovernanceRoleService.submitApproval's audit emit.
  async recordDelta(input: RecordDeltaInput): Promise<void> {
    const record = await this.insertReputationRecord(input);

    await this.audit.emit({
      actionType: "reputation.delta_recorded",
      actorRef: "system",
      payload: { reputationRecordId: record.id, citizenId: record.citizenId, factorType: record.factorType },
    });

    if (Math.abs(record.delta) >= SIGNIFICANT_DELTA_THRESHOLD) {
      await this.notification.emit({
        eventType: "reputation.significant_delta",
        citizenId: record.citizenId,
        payload: { factorType: record.factorType, delta: record.delta, reason: record.reason },
      });
    }
  }

  // reputation_record's INSERT policy is api_worker-only ("system-computed",
  // ARCH-023 §6) -- no citizen-facing write of any kind exists for this
  // table. A foreign-key violation on citizenId maps to
  // NotFoundDomainError("citizen", ...).
  private async insertReputationRecord(input: RecordDeltaInput): Promise<ReputationRecord> {
    try {
      const row = await this.prisma.forWorker((tx) =>
        tx.reputationRecord.create({
          data: {
            citizenId: input.citizenId,
            factorType: input.factorType,
            delta: input.delta,
            reason: input.reason,
          },
        }),
      );
      return toReputationRecord(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        throw new NotFoundDomainError("citizen", input.citizenId);
      }
      throw err;
    }
  }
}

function toReputationRecord(row: {
  id: string;
  citizenId: string;
  factorType: ReputationRecord["factorType"];
  delta: Prisma.Decimal;
  reason: string;
  createdAt: Date;
}): ReputationRecord {
  return {
    id: row.id,
    citizenId: row.citizenId,
    factorType: row.factorType,
    delta: row.delta.toNumber(),
    reason: row.reason,
    createdAt: row.createdAt,
  };
}
