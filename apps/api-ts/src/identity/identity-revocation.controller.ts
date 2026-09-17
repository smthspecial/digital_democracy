import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from "@nestjs/common";
import { RequiredCitizenId } from "../common/citizen-id.decorator.js";
import { RequestRevocationDto } from "./dto/request-revocation.dto.js";
import { IdentityRevocationService } from "./identity-revocation.service.js";

// US-004/FR-007/ADR-034. Distinct controller from IdentityController so
// this module can import GovernanceRoleModule (for APPROVAL_GATE) without
// IdentityModule itself depending on it -- GovernanceRoleModule already
// imports IdentityModule for CITIZEN_STATUS_CHECKER, so the reverse edge
// would be circular.
@Controller("identity/revocations")
export class IdentityRevocationController {
  constructor(@Inject(IdentityRevocationService) private readonly revocation: IdentityRevocationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  request(@RequiredCitizenId() actorId: string, @Body() dto: RequestRevocationDto) {
    return this.revocation.request(actorId, dto);
  }

  @Get(":actionRef")
  findByActionRef(@Param("actionRef") actionRef: string) {
    return this.revocation.findByActionRef(actionRef);
  }

  @Post(":actionRef/execute")
  execute(@Param("actionRef") actionRef: string) {
    return this.revocation.execute(actionRef);
  }
}
