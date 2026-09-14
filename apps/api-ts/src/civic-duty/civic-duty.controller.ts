import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { CivicDutyService } from "./civic-duty.service.js";
import { ClaimExemptionDto } from "./dto/claim-exemption.dto.js";
import type { CivicAssignmentStatus } from "./civic-duty.types.js";

// Route prefix per ADR-027. No DP-NNN doc backs these routes directly (all
// of SRV-009's own Operations are async/cron, out of scope this pass) --
// they realize AUTH-010's citizen-facing civic-duty permissions
// (assignment:accept, assignment:abandon, exemption:claim) instead.
@Controller("civic-duty")
export class CivicDutyController {
  constructor(@Inject(CivicDutyService) private readonly civicDuty: CivicDutyService) {}

  // Own-scoped read (ARCH-023 §6: civic_assignment is OWN, no public read).
  @Get("assignments")
  listAssignments(@RequiredCitizenId() citizenId: string, @Query("status") status?: CivicAssignmentStatus) {
    return this.civicDuty.listAssignments(citizenId, status ? { status } : undefined);
  }

  // AUTH-010 assignment:accept (own) -- see CivicDutyService.completeAssignment's note.
  @Post("assignments/:id/complete")
  completeAssignment(@RequiredCitizenId() citizenId: string, @Param("id") id: string) {
    return this.civicDuty.completeAssignment(citizenId, id);
  }

  // AUTH-010 assignment:abandon (own).
  @Post("assignments/:id/abandon")
  abandonAssignment(@RequiredCitizenId() citizenId: string, @Param("id") id: string) {
    return this.civicDuty.abandonAssignment(citizenId, id);
  }

  // Own-scoped read (ARCH-023 §6: participation_record is OWN, private
  // participation history).
  @Get("participation")
  listParticipation(@RequiredCitizenId() citizenId: string, @Query("period") period?: string) {
    return this.civicDuty.listParticipation(citizenId, period ? { period } : undefined);
  }

  // AUTH-010 exemption:claim (own) -- see CivicDutyService.claimExemption's note.
  @Post("participation/exemption")
  @HttpCode(HttpStatus.OK)
  claimExemption(@RequiredCitizenId() citizenId: string, @Body() dto: ClaimExemptionDto) {
    return this.civicDuty.claimExemption(citizenId, dto);
  }
}
