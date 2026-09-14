import { Module } from "@nestjs/common";
import { BudgetModule } from "../budget/budget.module.js";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { HttpNotificationEmitter, NOTIFICATION_EMITTER } from "../common/notification-emitter.js";
import { GovernanceRoleModule } from "../governance-role/governance-role.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { ReputationModule } from "../reputation/reputation.module.js";
import { ProjectController } from "./project.controller.js";
import { ProjectService } from "./project.service.js";

// GovernanceRoleModule exports GOVERNANCE_ROLE_CHECKER (DP-018/DP-022's
// role-type eligibility checks); BudgetModule exports BUDGET_LEDGER
// (DP-018's spend-report ledger push); ReputationModule exports
// REPUTATION_RECORDER (DP-022's outcome-success reputation trigger).
// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [ProjectModule] }) -- as
// project.controller.e2e.spec.ts uses -- can resolve/override PrismaService
// without needing the whole AppModule.
@Module({
  imports: [PrismaModule, GovernanceRoleModule, BudgetModule, ReputationModule],
  controllers: [ProjectController],
  providers: [
    ProjectService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: NOTIFICATION_EMITTER, useClass: HttpNotificationEmitter },
  ],
  exports: [ProjectService],
})
export class ProjectModule {}
