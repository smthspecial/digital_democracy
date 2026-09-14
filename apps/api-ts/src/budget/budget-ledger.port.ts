import type { LedgerEntry, RecordLedgerEntryInput } from "./budget.types.js";

// Cross-module port implemented by BudgetService, consumed by ProjectModule:
// SRV-013.md's Key Rules state that a reported project spend "also pushes a
// project-tagged ledger_entry outflow into budget-service's public ledger,
// so the same spend is traceable government-wide too" -- a direct push at
// write time (DP-018), not DP-055's category-level reconciliation cron.
// All services share one app/database (ADR-027/028), so this is an ordinary
// in-process Nest import (BudgetModule exports this token), not an HTTP
// seam -- mirrors PROPOSAL_SUPPORT_RECOMPUTER/GOVERNANCE_ROLE_CHECKER.
export const BUDGET_LEDGER = Symbol("BUDGET_LEDGER");

export interface BudgetLedger {
  recordLedgerEntry(input: RecordLedgerEntryInput): Promise<LedgerEntry>;
}
