import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ReputationService } from "./reputation.service.js";

// Route prefix per ADR-027. Note: DP-038 ("Reputation score update") is
// deliberately NOT exposed over HTTP -- see reputation.module.ts /
// ReputationService.recordDelta for why (mirrors BudgetController's own note
// on DP-019).
@Controller("reputation")
export class ReputationController {
  constructor(@Inject(ReputationService) private readonly reputation: ReputationService) {}

  // Public read (ARCH-023 §6), optionally filtered by citizenId.
  @Get("records")
  listRecords(@Query("citizenId") citizenId?: string) {
    return this.reputation.listRecords(citizenId ? { citizenId } : undefined);
  }
}
