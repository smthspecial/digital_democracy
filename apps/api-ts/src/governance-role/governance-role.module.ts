import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { GOVERNANCE_ROLE_CHECKER } from "./governance-role-checker.port.js";
import { GovernanceRoleController } from "./governance-role.controller.js";
import { GovernanceRoleService } from "./governance-role.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active, AUTH-010),
// consumed by GovernanceRoleService.submitApproval. AUTH-010's
// approval:submit:council coi.none condition is NOT enforced anywhere in
// this module: DP-023/TBL-033's action_ref is free-text with no domain link
// anywhere in the schema, so there is no domain to check
// conflict_of_interest against -- a spec gap, flagged here rather than
// inventing a resolution mechanism (same practice as
// competency.service.ts's DP-010 judgment-call comments).
// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [GovernanceRoleModule] }) -- as
// governance-role.controller.e2e.spec.ts uses -- can resolve/override
// PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [GovernanceRoleController],
  providers: [
    GovernanceRoleService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: GOVERNANCE_ROLE_CHECKER, useExisting: GovernanceRoleService },
  ],
  exports: [GovernanceRoleService, GOVERNANCE_ROLE_CHECKER],
})
export class GovernanceRoleModule {}
