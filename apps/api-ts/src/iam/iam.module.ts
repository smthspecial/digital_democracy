import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { GovernanceRoleModule } from "../governance-role/governance-role.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { IamController } from "./iam.controller.js";
import { IamService } from "./iam.service.js";

// GovernanceRoleModule exports GOVERNANCE_ROLE_CHECKER, consumed by
// IamService for every propose/endorse/revoke eligibility check (ADR-025:
// "never trusted from the request body") and by evaluate's role:* principal
// expansion (ARCH-024 §1). PrismaModule is @Global() (app.module.ts already
// imports it once for the real app) but is imported here too so a
// standalone Test.createTestingModule({ imports: [IamModule] }) -- as
// iam.controller.e2e.spec.ts uses -- can resolve/override PrismaService
// without needing the whole AppModule.
@Module({
  imports: [PrismaModule, GovernanceRoleModule],
  controllers: [IamController],
  providers: [IamService, { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter }],
  exports: [IamService],
})
export class IamModule {}
