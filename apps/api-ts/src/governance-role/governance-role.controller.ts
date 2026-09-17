import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { SubmitApprovalDto } from "./dto/submit-approval.dto.js";
import { GovernanceRoleService } from "./governance-role.service.js";
import type { GovernanceRoleType } from "./governance-role.types.js";

// Route prefix per ADR-027 (kebab-case for this two-word service title);
// resource paths realize DP-023's literal trigger with the leading slash
// stripped.
@Controller("governance-role")
export class GovernanceRoleController {
  constructor(@Inject(GovernanceRoleService) private readonly governanceRole: GovernanceRoleService) {}

  // No DP-NNN trigger for this read -- SRV-011's reads have no DP doc of
  // their own (mirrors jurisdiction/expert_domain/budget_category). Fully
  // public: governance_role's SELECT policy is USING(true) for both roles.
  @Get("roles")
  listRoles(@Query("citizenId") citizenId?: string, @Query("roleType") roleType?: GovernanceRoleType) {
    return this.governanceRole.listRoles(citizenId || roleType ? { citizenId, roleType } : undefined);
  }

  // DP-023. AUTH-010 approval:submit:operator/:council -- scope any,
  // condition role.term (+ coi.none for :council, not enforced here -- see
  // GovernanceRoleService.submitApproval's note).
  @Post("approvals")
  @HttpCode(HttpStatus.CREATED)
  submitApproval(@RequiredCitizenId() citizenId: string, @Body() dto: SubmitApprovalDto) {
    return this.governanceRole.submitApproval(citizenId, dto);
  }

  // FR-007 / CON-005 transparency -- public read, optionally filtered by
  // actionRef.
  @Get("approvals")
  listApprovals(@Query("actionRef") actionRef?: string) {
    return this.governanceRole.listApprovals(actionRef ? { actionRef } : undefined);
  }

  @Get("actions/:actionRef/status")
  async actionStatus(@Param("actionRef") actionRef: string) {
    return { fullyApproved: await this.governanceRole.isFullyApproved(actionRef) };
  }
}
