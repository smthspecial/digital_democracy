import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { CompetencyController } from "./competency.controller.js";
import { CompetencyService } from "./competency.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active, AUTH-010)
// -- consumed by CompetencyService for every write. No AUDIT_EMITTER
// provider: none of DP-010/011/012/021's doc text says "Emits DP-036".
// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [CompetencyModule] }) -- as
// competency.controller.e2e.spec.ts uses -- can resolve/override
// PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [CompetencyController],
  providers: [CompetencyService],
  exports: [CompetencyService],
})
export class CompetencyModule {}
