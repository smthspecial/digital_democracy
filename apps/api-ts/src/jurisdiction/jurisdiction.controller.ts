import { Controller, Get, Inject } from "@nestjs/common";
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
}
