import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { GovernanceRoleModule } from "../governance-role/governance-role.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { JurisdictionModule } from "../jurisdiction/jurisdiction.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { CONSTITUTIONAL_REVIEWER, HttpConstitutionalReviewer } from "./constitutional-reviewer.port.js";
import { DeadlockService } from "./deadlock.service.js";
import { PROPOSAL_SUPPORT_RECOMPUTER } from "./proposal-support.port.js";
import { ProposalController } from "./proposal.controller.js";
import { ProposalService } from "./proposal.service.js";

// IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active, AUTH-010)
// and JurisdictionModule exports JURISDICTION_MEMBERSHIP_CHECKER (DP-020's
// jurisdiction:affected) -- both consumed by ProposalService. PrismaModule
// is @Global() (app.module.ts already imports it once for the real app) but
// is imported here too so a standalone
// Test.createTestingModule({ imports: [ProposalModule] }) -- as
// proposal.controller.e2e.spec.ts uses -- can resolve/override PrismaService
// without needing the whole AppModule.
@Module({
  imports: [PrismaModule, IdentityModule, JurisdictionModule, GovernanceRoleModule],
  controllers: [ProposalController],
  providers: [
    ProposalService,
    DeadlockService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    { provide: PROPOSAL_SUPPORT_RECOMPUTER, useExisting: ProposalService },
    { provide: CONSTITUTIONAL_REVIEWER, useClass: HttpConstitutionalReviewer },
  ],
  exports: [ProposalService, PROPOSAL_SUPPORT_RECOMPUTER, DeadlockService],
})
export class ProposalModule {}
