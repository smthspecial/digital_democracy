import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { EvaluateAccessDto } from "./dto/evaluate-access.dto.js";
import { ProposeAttachmentDto } from "./dto/propose-attachment.dto.js";
import { ProposePolicyDto } from "./dto/propose-policy.dto.js";
import { SubmitEndorsementDto } from "./dto/submit-endorsement.dto.js";
import type { AccessPolicyStatus, PolicyAttachmentStatus } from "./iam.types.js";
import { IamService } from "./iam.service.js";

// Route prefix per ADR-027; resource paths realize ARCH-024 §5's literal
// change-flow shape (separate policies/attachments routes, per-target
// endorsement/revoke sub-routes).
@Controller("iam")
export class IamController {
  constructor(@Inject(IamService) private readonly iam: IamService) {}

  // DP-069 (policy half). AUTH-006/AUTH-011-gated -- proposer must hold an
  // active operator/platform_operator role.
  @Post("policies")
  @HttpCode(HttpStatus.CREATED)
  proposePolicy(@RequiredCitizenId() citizenId: string, @Body() dto: ProposePolicyDto) {
    return this.iam.proposePolicy(citizenId, dto);
  }

  // CON-005: every policy is publicly readable.
  @Get("policies")
  listPolicies(@Query("status") status?: AccessPolicyStatus) {
    return this.iam.listPolicies(status ? { status } : undefined);
  }

  // DP-069 (attachment half).
  @Post("attachments")
  @HttpCode(HttpStatus.CREATED)
  proposeAttachment(@RequiredCitizenId() citizenId: string, @Body() dto: ProposeAttachmentDto) {
    return this.iam.proposeAttachment(citizenId, dto);
  }

  @Get("attachments")
  listAttachments(
    @Query("policyId") policyId?: string,
    @Query("principalRef") principalRef?: string,
    @Query("status") status?: PolicyAttachmentStatus,
  ) {
    return this.iam.listAttachments(
      policyId || principalRef || status ? { policyId, principalRef, status } : undefined,
    );
  }

  // DP-070, targeting a proposed policy.
  @Post("policies/:id/endorsements")
  @HttpCode(HttpStatus.CREATED)
  endorsePolicy(@RequiredCitizenId() citizenId: string, @Param("id") id: string, @Body() dto: SubmitEndorsementDto) {
    return this.iam.submitEndorsement(citizenId, { targetType: "policy", targetId: id, decision: dto.decision });
  }

  // DP-070, targeting a proposed attachment.
  @Post("attachments/:id/endorsements")
  @HttpCode(HttpStatus.CREATED)
  endorseAttachment(@RequiredCitizenId() citizenId: string, @Param("id") id: string, @Body() dto: SubmitEndorsementDto) {
    return this.iam.submitEndorsement(citizenId, { targetType: "attachment", targetId: id, decision: dto.decision });
  }

  // Transparency of who endorsed what (ARCH-024 §3).
  @Get("endorsements")
  listEndorsements(@Query("targetType") targetType?: "policy" | "attachment", @Query("targetId") targetId?: string) {
    return this.iam.listEndorsements(targetType || targetId ? { targetType, targetId } : undefined);
  }

  // DP-072, targeting a policy. No dual control -- unilateral, immediate.
  @Post("policies/:id/revoke")
  revokePolicy(@RequiredCitizenId() citizenId: string, @Param("id") id: string) {
    return this.iam.revoke(citizenId, { targetType: "policy", targetId: id });
  }

  // DP-072, targeting an attachment.
  @Post("attachments/:id/revoke")
  revokeAttachment(@RequiredCitizenId() citizenId: string, @Param("id") id: string) {
    return this.iam.revoke(citizenId, { targetType: "attachment", targetId: id });
  }

  // DP-071. Not gated behind @RequiredCitizenId() -- see EvaluateAccessDto's
  // own note; a caller passes the concrete principal to evaluate.
  @Post("evaluate")
  evaluate(@Body() dto: EvaluateAccessDto) {
    return this.iam.evaluate(dto);
  }
}
