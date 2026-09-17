import { Inject, Injectable } from "@nestjs/common";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { NOTIFICATION_EMITTER, type NotificationEmitter } from "../common/notification-emitter.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { Competency, CompetencyStage, CompetencyStageReview } from "./competency.types.js";

const STAGE_ORDER: readonly CompetencyStage[] = [
  "intake",
  "credential_verification",
  "public_review",
  "domain_peer_review",
  "decided",
];

// ADR-037 D23: flat validity term, one named constant.
export const COMPETENCY_VALIDITY_YEARS = 3;

export interface AdvanceInput {
  reviewerId: string | null;
  notes: string;
}

// ADR-037/E4-05: the pipeline substrate -- every stage-specific service
// (E4-06 automated credential check, E4-07 public review, E4-08 domain
// peer review, E4-09 recorded approval) calls advance()/reject() rather
// than writing competency.status/stage directly, so the review history and
// the grant/reject audit trail can never be bypassed. Worker-scoped: no
// api_app write policy exists on competency_stage_review's status-mutating
// path (competency_worker_all).
@Injectable()
export class CompetencyPipelineService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
    @Inject(NOTIFICATION_EMITTER) private readonly notification: NotificationEmitter,
  ) {}

  async listReviews(competencyId: string): Promise<CompetencyStageReview[]> {
    return this.prisma.app.competencyStageReview.findMany({ where: { competencyId }, orderBy: { createdAt: "asc" } });
  }

  // Records a passing review at the competency's current stage and moves
  // it to the next stage. Advancing past the final stage (domain_peer_review
  // -> decided) grants the competency: status active, grantedAt now,
  // expiresAt now + COMPETENCY_VALIDITY_YEARS.
  async advance(competencyId: string, input: AdvanceInput): Promise<Competency> {
    const competency = await this.getOrThrow(competencyId);
    if (competency.stage === "decided" || competency.status !== "applied") {
      throw new InvalidStateDomainError(
        `Competency ${competencyId} is not mid-pipeline (status=${competency.status}, stage=${competency.stage})`,
      );
    }

    const currentIndex = STAGE_ORDER.indexOf(competency.stage);
    const nextStage = STAGE_ORDER[currentIndex + 1];

    return this.prisma.forWorker(async (tx) => {
      await tx.competencyStageReview.create({
        data: {
          competencyId,
          stage: competency.stage,
          reviewerId: input.reviewerId,
          decision: "passed",
          notes: input.notes,
        },
      });

      if (nextStage === "decided") {
        const grantedAt = new Date();
        const expiresAt = new Date(grantedAt);
        expiresAt.setFullYear(expiresAt.getFullYear() + COMPETENCY_VALIDITY_YEARS);
        const updated = await tx.competency.update({
          where: { id: competencyId },
          data: { stage: nextStage, status: "active", grantedAt, expiresAt },
        });
        await this.audit.emit({
          actionType: "competency.granted",
          actorRef: input.reviewerId ?? "system",
          payload: { competencyId, domainId: competency.domainId },
        });
        await this.notification.emit({
          eventType: "competency.granted",
          citizenId: competency.citizenId,
          payload: { competencyId, domainId: competency.domainId },
        });
        return updated;
      }

      return tx.competency.update({ where: { id: competencyId }, data: { stage: nextStage } });
    });
  }

  async reject(competencyId: string, input: AdvanceInput): Promise<Competency> {
    const competency = await this.getOrThrow(competencyId);
    if (competency.stage === "decided" || competency.status !== "applied") {
      throw new InvalidStateDomainError(
        `Competency ${competencyId} is not mid-pipeline (status=${competency.status}, stage=${competency.stage})`,
      );
    }

    return this.prisma.forWorker(async (tx) => {
      await tx.competencyStageReview.create({
        data: { competencyId, stage: competency.stage, reviewerId: input.reviewerId, decision: "failed", notes: input.notes },
      });
      const updated = await tx.competency.update({
        where: { id: competencyId },
        data: { stage: "decided", status: "rejected" },
      });
      await this.notification.emit({
        eventType: "competency.rejected",
        citizenId: competency.citizenId,
        payload: { competencyId, domainId: competency.domainId, notes: input.notes },
      });
      return updated;
    });
  }

  private async getOrThrow(competencyId: string): Promise<Competency> {
    const competency = await this.prisma.app.competency.findUnique({ where: { id: competencyId } });
    if (!competency) {
      throw new NotFoundDomainError("competency", competencyId);
    }
    return competency;
  }
}
