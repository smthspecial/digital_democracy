import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { DeclareResidencyDto } from "./dto/declare-residency.dto.js";
import { EnrollMembershipDto } from "./dto/enroll-membership.dto.js";
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

  // E2-04. Own-scoped write -- RLS already supported this (init migration),
  // no service method existed until now.
  @Post("residencies")
  @HttpCode(HttpStatus.CREATED)
  async declareResidency(@RequiredCitizenId() citizenId: string, @Body() dto: DeclareResidencyDto) {
    await this.jurisdiction.declareResidency(citizenId, dto.jurisdictionId, new Date(dto.startDate));
    return { status: "declared" };
  }

  @Post("memberships")
  @HttpCode(HttpStatus.CREATED)
  async enrollMembership(@RequiredCitizenId() citizenId: string, @Body() dto: EnrollMembershipDto) {
    await this.jurisdiction.enrollMembership(citizenId, dto.jurisdictionId);
    return { status: "enrolled" };
  }
}
