import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { CITIZEN_STATUS_CHECKER } from "./citizen-status.port.js";
import { IdentityController } from "./identity.controller.js";
import { IdentityService } from "./identity.service.js";

// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [IdentityModule] }) -- as
// identity.controller.e2e.spec.ts uses -- can resolve/override PrismaService
// without needing the whole AppModule.
@Module({
  imports: [PrismaModule],
  controllers: [IdentityController],
  providers: [
    IdentityService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: CITIZEN_STATUS_CHECKER, useExisting: IdentityService },
  ],
  exports: [IdentityService, CITIZEN_STATUS_CHECKER],
})
export class IdentityModule {}
