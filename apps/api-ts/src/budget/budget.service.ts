import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { assertActiveCitizen } from "../common/assert-active-citizen.js";
import { AUDIT_EMITTER, type AuditEmitter } from "../common/audit-emitter.js";
import { ConflictDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import { CITIZEN_STATUS_CHECKER } from "../identity/citizen-status.port.js";
import type { CitizenStatusChecker } from "../identity/citizen-status.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { BudgetLedger } from "./budget-ledger.port.js";
import {
  AllocationEntryInput,
  BudgetAllocationVote,
  BudgetCategory,
  BudgetCategoryListFilter,
  LedgerEntry,
  LedgerEntryListFilter,
  RecordLedgerEntryInput,
  ReplaceAllocationForPeriodInput,
} from "./budget.types.js";

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";

// AUTH-010 budget:vote's `totals:100` condition -- a small tolerance so a
// split like 33.33/33.33/33.34 (exact 100 on paper, but the kind of value a
// real client rounds to two decimals) isn't spuriously rejected.
const TOTAL_PERCENTAGE = 100;
const TOTAL_TOLERANCE = 0.01;

export interface SubmitAllocationInput {
  period: string;
  allocations: AllocationEntryInput[];
}

// DP-013/019, SRV-007: talks to Postgres directly via PrismaService's dual
// api_app/api_worker connections (ADR-030) -- no repository indirection.
@Injectable()
export class BudgetService implements BudgetLedger {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CITIZEN_STATUS_CHECKER) private readonly citizenStatus: CitizenStatusChecker,
    @Inject(AUDIT_EMITTER) private readonly audit: AuditEmitter,
  ) {}

  // budget_category_public_read is USING(true) for both roles -- no citizen
  // context needed, same as JurisdictionService.getTree's plain app read.
  async listCategories(filter?: BudgetCategoryListFilter): Promise<BudgetCategory[]> {
    const rows = await this.prisma.app.budgetCategory.findMany({
      where: filter?.jurisdictionId ? { jurisdictionId: filter.jurisdictionId } : undefined,
    });
    return rows.map(toBudgetCategory);
  }

  // DP-013: AUTH-010 budget:vote -- scope any, conditions citizen.active +
  // totals:100. No audit emit (DP-013.md doesn't say "Emits DP-036").
  async submitAllocation(citizenId: string, input: SubmitAllocationInput): Promise<BudgetAllocationVote[]> {
    await assertActiveCitizen(this.citizenStatus, citizenId);
    this.assertTotalsHundred(input.allocations);
    return this.replaceAllocationForPeriod({
      citizenId,
      period: input.period,
      allocations: input.allocations,
    });
  }

  // Always the CALLING citizen's own id, never a target-citizen parameter --
  // budget_allocation_vote has no public-read policy, so there is no scope
  // under which anyone reads another citizen's allocation votes. OWN read
  // (budget_allocation_vote_own_select): forCitizen(citizenId, ...) with
  // citizenId as both the RLS context and the filter target -- the same
  // trick JurisdictionService.isMember uses.
  async getMyAllocation(citizenId: string, period: string): Promise<BudgetAllocationVote[]> {
    const rows = await this.prisma.forCitizen(citizenId, (tx) =>
      tx.budgetAllocationVote.findMany({ where: { citizenId, period } }),
    );
    return rows.map(toBudgetAllocationVote);
  }

  // DP-019: AUTH-006 ledger_entry:record is an operator permission enforced
  // by iam-service's policy engine (SRV-018, not built) -- there is no
  // operator-auth mechanism anywhere in this app, unlike citizen auth
  // (ADR-030's header seam). So this stays an internal capability with no
  // citizen actor and no HTTP route (see budget.module.ts / budget.controller.ts):
  // exposing an unauthenticated POST here would let any caller inject
  // arbitrary financial ledger entries. DP-019.md: "Emits DP-036".
  async recordLedgerEntry(input: RecordLedgerEntryInput): Promise<LedgerEntry> {
    const entry = await this.insertLedgerEntry(input);
    await this.audit.emit({
      actionType: "budget.ledger_entry_recorded",
      actorRef: "system",
      payload: { ledgerEntryId: entry.id, jurisdictionId: entry.jurisdictionId, direction: entry.direction },
    });
    return entry;
  }

  // Public read (FR-036's real-time public ledger).
  async listLedgerEntries(filter?: LedgerEntryListFilter): Promise<LedgerEntry[]> {
    const rows = await this.prisma.app.ledgerEntry.findMany({
      where: {
        ...(filter?.jurisdictionId ? { jurisdictionId: filter.jurisdictionId } : {}),
        ...(filter?.categoryId ? { categoryId: filter.categoryId } : {}),
        ...(filter?.projectId ? { projectId: filter.projectId } : {}),
      },
    });
    return rows.map(toLedgerEntry);
  }

  private assertTotalsHundred(allocations: AllocationEntryInput[]): void {
    // An empty array is DP-013's "clear my allocation for this period" call
    // (SRV-007 task brief) -- delete-only, so the sum-to-100 gate doesn't
    // apply to it.
    if (allocations.length === 0) {
      return;
    }
    const sum = allocations.reduce((total, allocation) => total + allocation.percentage, 0);
    if (Math.abs(sum - TOTAL_PERCENTAGE) >= TOTAL_TOLERANCE) {
      throw new InvalidStateDomainError(`Budget allocation percentages must sum to 100; got ${sum}`);
    }
  }

  // budget_allocation_vote_own_{select,insert,update,delete} are ALL OWN --
  // forCitizen(input.citizenId, ...) covers the whole transactional replace.
  // SRV-007.md's cross-row "sum to 100%" invariant is enforced by
  // assertTotalsHundred before this is ever called; this is just the
  // delete-old/insert-new pair the migration's explicit DELETE grant exists
  // for (see migration.sql's budget_allocation_vote comment). An empty
  // `allocations` array is delete-only ("clear my allocation"). Inserted one
  // at a time (not Promise.all) so a P2003/P2002 can be attributed to the
  // exact categoryId that caused it.
  private async replaceAllocationForPeriod(input: ReplaceAllocationForPeriodInput): Promise<BudgetAllocationVote[]> {
    return this.prisma.forCitizen(input.citizenId, async (tx) => {
      await tx.budgetAllocationVote.deleteMany({ where: { citizenId: input.citizenId, period: input.period } });

      const created: BudgetAllocationVote[] = [];
      for (const allocation of input.allocations) {
        try {
          const row = await tx.budgetAllocationVote.create({
            data: {
              citizenId: input.citizenId,
              categoryId: allocation.categoryId,
              percentage: allocation.percentage,
              period: input.period,
            },
          });
          created.push(toBudgetAllocationVote(row));
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
            throw new NotFoundDomainError("category", allocation.categoryId);
          }
          // budget_allocation_vote's @@unique([citizenId, categoryId, period])
          // -- the rows just got deleted above, so this only fires when the
          // same categoryId appears more than once within this one
          // submission's `allocations` array (never a resubmission race:
          // convention across every service in this app is to never let a
          // raw PrismaClientKnownRequestError escape).
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION) {
            throw new ConflictDomainError(`Duplicate allocation for category ${allocation.categoryId} in this submission`);
          }
          throw err;
        }
      }
      return created;
    });
  }

  // ledger_entry's INSERT policy is api_worker-only (AUTH-006
  // ledger_entry:record is an operator permission, not a citizen one) --
  // forWorker(...).
  private async insertLedgerEntry(input: RecordLedgerEntryInput): Promise<LedgerEntry> {
    try {
      const row = await this.prisma.forWorker((tx) =>
        tx.ledgerEntry.create({
          data: {
            jurisdictionId: input.jurisdictionId,
            categoryId: input.categoryId ?? undefined,
            projectId: input.projectId ?? undefined,
            direction: input.direction,
            amount: input.amount,
            source: input.source,
            occurredAt: input.occurredAt,
          },
        }),
      );
      return toLedgerEntry(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === FOREIGN_KEY_VIOLATION) {
        // Unlike every other FK mapping in this app, this single create()
        // can violate either of two FK columns (jurisdiction_id,
        // category_id); disambiguate from the driver's own constraint name
        // (verified live against dev Postgres: err.meta.driverAdapterError
        // .cause.constraint.index is e.g. "ledger_entry_category_id_fkey").
        // jurisdictionId is always required and thus the safer default if
        // that shape ever changes across a Prisma upgrade.
        if (violatedConstraintName(err).includes("category_id")) {
          throw new NotFoundDomainError("category", input.categoryId ?? "");
        }
        throw new NotFoundDomainError("jurisdiction", input.jurisdictionId);
      }
      throw err;
    }
  }
}

function violatedConstraintName(err: Prisma.PrismaClientKnownRequestError): string {
  const meta = err.meta as { driverAdapterError?: { cause?: { constraint?: { index?: string } } } } | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.index ?? "";
}

function toBudgetCategory(row: {
  id: string;
  jurisdictionId: string;
  parentId: string | null;
  name: string;
  allocatedAmount: Prisma.Decimal | null;
}): BudgetCategory {
  return {
    id: row.id,
    jurisdictionId: row.jurisdictionId,
    parentId: row.parentId,
    name: row.name,
    allocatedAmount: row.allocatedAmount === null ? null : row.allocatedAmount.toNumber(),
  };
}

function toBudgetAllocationVote(row: {
  id: string;
  citizenId: string;
  categoryId: string;
  percentage: Prisma.Decimal;
  period: string;
}): BudgetAllocationVote {
  return {
    id: row.id,
    citizenId: row.citizenId,
    categoryId: row.categoryId,
    percentage: row.percentage.toNumber(),
    period: row.period,
  };
}

function toLedgerEntry(row: {
  id: string;
  jurisdictionId: string;
  categoryId: string | null;
  projectId: string | null;
  direction: LedgerEntry["direction"];
  amount: Prisma.Decimal;
  source: string;
  occurredAt: Date;
}): LedgerEntry {
  return {
    id: row.id,
    jurisdictionId: row.jurisdictionId,
    categoryId: row.categoryId,
    projectId: row.projectId,
    direction: row.direction,
    amount: row.amount.toNumber(),
    source: row.source,
    occurredAt: row.occurredAt,
  };
}
