import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { HttpNotificationEmitter, NOTIFICATION_EMITTER } from "../common/notification-emitter.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { REPUTATION_RECORDER } from "./reputation-recorder.port.js";
import { ReputationController } from "./reputation.controller.js";
import { ReputationService } from "./reputation.service.js";

// recordDelta has no HTTP route (see ReputationController's note) --
// ReputationService is exported both as itself and as REPUTATION_RECORDER
// so ProjectModule can call it in-process, mirroring
// GovernanceRoleModule's own useExisting pattern for GOVERNANCE_ROLE_CHECKER.
// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [ReputationModule] }) -- as
// reputation.controller.e2e.spec.ts uses -- can resolve/override
// PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule],
  controllers: [ReputationController],
  providers: [
    ReputationService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: NOTIFICATION_EMITTER, useClass: HttpNotificationEmitter },
    { provide: REPUTATION_RECORDER, useExisting: ReputationService },
  ],
  exports: [ReputationService, REPUTATION_RECORDER],
})
export class ReputationModule {}
