import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { BudgetService } from "./budget.service.js";
import { SubmitAllocationDto } from "./dto/submit-allocation.dto.js";

// Route prefix per ADR-027 (one prefix per hosted service); resource paths
// realize each DP doc's literal trigger with the leading slash stripped.
// Note: DP-019 ("Record ledger entry", trigger "POST /ledger") is
// deliberately NOT exposed here -- see budget.module.ts / BudgetService.
// recordLedgerEntry for why.
@Controller("budget")
export class BudgetController {
  constructor(@Inject(BudgetService) private readonly budget: BudgetService) {}

  // Public read -- reference data (budget_category), optionally filtered by
  // jurisdictionId.
  @Get("categories")
  listCategories(@Query("jurisdictionId") jurisdictionId?: string) {
    return this.budget.listCategories(jurisdictionId ? { jurisdictionId } : undefined);
  }

  // DP-013. AUTH-010 budget:vote -- scope any, conditions citizen.active +
  // totals:100.
  @Post("budget-votes")
  @HttpCode(HttpStatus.CREATED)
  submitAllocation(@RequiredCitizenId() citizenId: string, @Body() dto: SubmitAllocationDto) {
    return this.budget.submitAllocation(citizenId, dto);
  }

  // Own-scoped read: budget_allocation_vote has no public-read policy, so
  // this only ever returns the caller's own allocation for the given
  // period. `period` is required -- silently returning "everything" for a
  // missing period would be the wrong default for a vote-adjacent table.
  @Get("budget-votes")
  getMyAllocation(@RequiredCitizenId() citizenId: string, @Query("period") period?: string) {
    if (!period) {
      throw new BadRequestException("period query parameter is required");
    }
    return this.budget.getMyAllocation(citizenId, period);
  }

  // Public read (FR-036's real-time public ledger), optionally filtered.
  @Get("ledger")
  listLedgerEntries(
    @Query("jurisdictionId") jurisdictionId?: string,
    @Query("categoryId") categoryId?: string,
    @Query("projectId") projectId?: string,
  ) {
    return this.budget.listLedgerEntries(
      jurisdictionId || categoryId || projectId ? { jurisdictionId, categoryId, projectId } : undefined,
    );
  }
}
