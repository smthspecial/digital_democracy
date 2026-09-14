import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { DeliberationController } from "./deliberation.controller.js";
import { DeliberationService } from "./deliberation.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active,
// AUTH-010), consumed by DeliberationService for both DP-008 and DP-009.
// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [DeliberationModule] }) -- as
// deliberation.controller.e2e.spec.ts uses -- can resolve/override
// PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [DeliberationController],
  providers: [DeliberationService, { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter }],
  exports: [DeliberationService],
})
export class DeliberationModule {}
