import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { HttpNotificationEmitter, NOTIFICATION_EMITTER } from "../common/notification-emitter.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { CompetencyController } from "./competency.controller.js";
import { CompetencyExpiryService } from "./competency-expiry.service.js";
import { CompetencyPipelineService } from "./competency-pipeline.service.js";
import { CompetencyService } from "./competency.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active, AUTH-010)
// -- consumed by CompetencyService for every write. AUDIT_EMITTER/
// NOTIFICATION_EMITTER (E4-01): CompetencyService's own DP-010/011/012/021
// writes still emit nothing (no DP doc text says "Emits DP-036" for them),
// but CompetencyPipelineService's stage decisions and grant do.
// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [CompetencyModule] }) -- as
// competency.controller.e2e.spec.ts uses -- can resolve/override
// PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [CompetencyController],
  providers: [
    CompetencyService,
    CompetencyPipelineService,
    CompetencyExpiryService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: NOTIFICATION_EMITTER, useClass: HttpNotificationEmitter },
  ],
  exports: [CompetencyService, CompetencyPipelineService, CompetencyExpiryService],
})
export class CompetencyModule {}
