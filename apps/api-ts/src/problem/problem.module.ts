import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { IdentityModule } from "../identity/identity.module.js";
import { JurisdictionModule } from "../jurisdiction/jurisdiction.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { ProposalModule } from "../proposal/proposal.module.js";
import { ProblemController } from "./problem.controller.js";
import { ProblemService } from "./problem.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active, AUTH-010)
// and JurisdictionModule exports JURISDICTION_MEMBERSHIP_CHECKER (DP-004's
// jurisdiction:member) -- JurisdictionModule is imported directly (not
// only transitively via ProposalModule) since Nest module re-exports
// aren't transitive unless explicitly re-exported. ProposalModule exports
// PROPOSAL_SUPPORT_RECOMPUTER (DP-028's consumer side, called after every
// successful endorsement). PrismaModule is @Global() (app.module.ts already
// imports it once for the real app) but is imported here too so a
// standalone Test.createTestingModule({ imports: [ProblemModule] }) -- as
// problem.controller.e2e.spec.ts uses -- can resolve/override PrismaService
// without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule, JurisdictionModule, ProposalModule],
  controllers: [ProblemController],
  providers: [ProblemService, { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter }],
  exports: [ProblemService],
})
export class ProblemModule {}
