import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { JURISDICTION_MEMBERSHIP_CHECKER } from "./jurisdiction-membership.port.js";
import { JurisdictionController } from "./jurisdiction.controller.js";
import { JurisdictionService } from "./jurisdiction.service.js";

// PrismaModule is @Global() (app.module.ts already imports it once for the
// real app) but is imported here too so a standalone
// Test.createTestingModule({ imports: [JurisdictionModule] }) -- as
// jurisdiction.controller.e2e.spec.ts uses -- can resolve/override
// PrismaService without needing the whole AppModule.
@Module({
  imports: [PrismaModule],
  controllers: [JurisdictionController],
  providers: [JurisdictionService, { provide: JURISDICTION_MEMBERSHIP_CHECKER, useExisting: JurisdictionService }],
  exports: [JurisdictionService, JURISDICTION_MEMBERSHIP_CHECKER],
})
export class JurisdictionModule {}
