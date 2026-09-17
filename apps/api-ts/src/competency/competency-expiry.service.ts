import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { competencyExpirySweptTotal } from "../metrics/metrics.js";
import { PrismaService } from "../prisma/prisma.service.js";

@Injectable()
export class CompetencyExpiryService {
  private readonly logger = new Logger(CompetencyExpiryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweepExpired(): Promise<number> {
    const now = new Date();
    const { count } = await this.prisma.forWorker((tx) =>
      tx.competency.updateMany({
        where: { status: "active", expiresAt: { lt: now } },
        data: { status: "expired" },
      }),
    );
    if (count > 0) {
      this.logger.log(`expired ${count} competency record(s)`);
      competencyExpirySweptTotal.inc(count);
      await this.audit.emit({
        actionType: "competency.expiry_swept",
        actorRef: "scheduler",
        payload: { count },
      });
    }
    return count;
  }
}
