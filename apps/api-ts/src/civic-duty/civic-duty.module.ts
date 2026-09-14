import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { CivicDutyController } from "./civic-duty.controller.js";
import { CivicDutyService } from "./civic-duty.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active, AUTH-010),
// consumed by every write in CivicDutyService. PrismaModule is @Global()
// (app.module.ts already imports it once for the real app) but is imported
// here too so a standalone Test.createTestingModule({ imports:
// [CivicDutyModule] }) -- as civic-duty.controller.e2e.spec.ts uses -- can
// resolve/override PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [CivicDutyController],
  providers: [CivicDutyService, { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter }],
  exports: [CivicDutyService],
})
export class CivicDutyModule {}
