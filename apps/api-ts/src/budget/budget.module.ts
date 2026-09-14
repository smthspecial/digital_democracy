import { Module } from "@nestjs/common";
import { AUDIT_EMITTER, HttpAuditEmitter } from "../common/audit-emitter.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { BUDGET_LEDGER } from "./budget-ledger.port.js";
import { BudgetController } from "./budget.controller.js";
import { BudgetService } from "./budget.service.js";

@Module({
  // IdentityModule exports CITIZEN_STATUS_CHECKER (citizen.active,
  // AUTH-010), consumed by BudgetService.submitAllocation. AUDIT_EMITTER is
  // provided even though no HTTP route calls recordLedgerEntry yet
  // (DP-019.md's "Emits DP-036") -- ledger_entry:record is an operator
  // permission (AUTH-006) with no operator-auth mechanism anywhere in this
  // app yet, so it stays an internal, service-layer-only capability (see
  // BudgetService.recordLedgerEntry / BudgetController's note) rather than
  // an unauthenticated POST route that would let any caller inject
  // arbitrary financial ledger entries. PrismaModule is @Global() (app.module.ts
  // already imports it once for the real app) but is imported here too so a
  // standalone Test.createTestingModule({ imports: [BudgetModule] }) -- as
  // budget.controller.e2e.spec.ts uses -- can resolve/override PrismaService
  // without needing the whole AppModule.
  imports: [PrismaModule, IdentityModule],
  controllers: [BudgetController],
  providers: [
    BudgetService,
    { provide: AUDIT_EMITTER, useClass: HttpAuditEmitter },
    // Consumed by ProjectModule (SRV-013's spend-report ledger push) --
    // mirrors GovernanceRoleModule's own useExisting pattern.
    { provide: BUDGET_LEDGER, useExisting: BudgetService },
  ],
  exports: [BudgetService, BUDGET_LEDGER],
})
export class BudgetModule {}
