import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from "@nestjs/common";
import { InternalServiceGuard } from "../common/internal-service.guard.js";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { DeclareResidencyDto } from "./dto/declare-residency.dto.js";
import { EnrollMembershipDto } from "./dto/enroll-membership.dto.js";
import { ReviewResidencyDto } from "./dto/review-residency.dto.js";
import { JurisdictionService } from "./jurisdiction.service.js";

// Route prefix per ADR-027 (one prefix per hosted service). No DP-NNN
// trigger for this read -- SRV-002's reads have no DP doc of their own --
// "jurisdictions" is chosen to match the plural-resource convention
// identity/problem/proposal use. Fully public: jurisdiction's SELECT policy
// is USING(true) for both roles (ADR-030), so no @RequiredCitizenId.
@Controller("jurisdiction")
export class JurisdictionController {
  constructor(@Inject(JurisdictionService) private readonly jurisdiction: JurisdictionService) {}

  @Get("jurisdictions")
  getTree() {
    return this.jurisdiction.getTree();
  }

  @Get("proposals/:proposalId/jurisdictions/:id/eligible-citizens")
  @UseGuards(InternalServiceGuard)
  eligibleCitizens(@Param("proposalId", ParseUUIDPipe) proposalId: string,
                  @Param("id", ParseUUIDPipe) jurisdictionId: string, @Query("after") after?: string) {
    return this.jurisdiction.eligibleCitizens(proposalId, jurisdictionId, after);
  }

  // E2-04. Own-scoped write -- RLS already supported this (init migration),
  // no service method existed until now.
  @Post("residencies")
  @HttpCode(HttpStatus.CREATED)
  async declareResidency(@RequiredCitizenId() citizenId: string, @Body() dto: DeclareResidencyDto) {
    await this.jurisdiction.declareResidency(citizenId, dto.jurisdictionId, new Date(dto.startDate));
    return { status: "declared" };
  }

  @Get("residencies")
  ownResidencies(@RequiredCitizenId() citizenId: string) { return this.jurisdiction.ownResidencies(citizenId); }

  @Get("residencies/pending")
  pendingResidencies(@RequiredCitizenId("T3") reviewerId: string) { return this.jurisdiction.pendingResidencies(reviewerId); }

  @Post("residencies/:id/review")
  @HttpCode(HttpStatus.OK)
  async reviewResidency(
    @RequiredCitizenId("T3") reviewerId: string,
    @Param("id") residencyId: string,
    @Body() dto: ReviewResidencyDto,
  ) {
    await this.jurisdiction.reviewResidency(reviewerId, residencyId, dto.decision);
    return { status: dto.decision };
  }

  @Post("memberships")
  @HttpCode(HttpStatus.CREATED)
  async enrollMembership(@RequiredCitizenId() citizenId: string, @Body() dto: EnrollMembershipDto) {
    await this.jurisdiction.enrollMembership(citizenId, dto.jurisdictionId);
    return { status: "enrolled" };
  }
}
