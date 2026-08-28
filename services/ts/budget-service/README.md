# budget-service

TypeScript (ADR-019). Owns budget allocation votes and the public
spending ledger. Spec: [`.spec/technical/services/srv-007.md`](../../../.spec/technical/services/srv-007.md).
Route prefix `/budget` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4007 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/budget-service dev    # local dev server (tsx watch)
pnpm --filter @dd/budget-service test   # vitest
```

## Implemented

- `POST /budget/categories` -- create a budget category (hierarchical, via `parent_id`).
- `GET /budget/categories/:jurisdictionId/tree` -- the category hierarchy for a jurisdiction.
- `POST /budget/allocations` (DP-013) -- submit a citizen's full allocation set for a
  period; percentages across all categories must sum to exactly 100 (400 with the
  actual sum otherwise); replaces any prior rows for that citizen+period.
- `POST /budget/allocations/aggregate` (DP-051) -- given `{ period, total_pool }`,
  averages each voted-on category's percentage across citizens and writes
  `allocated_amount = total_pool * avgPercentage / 100`. `total_pool` is an explicit
  request field since this service's schema has no separate total-budget table.
- `POST /budget/ledger` (DP-019) -- append-only public ledger entry (inflow/outflow),
  optionally tagged with a `project_id` (TBL-028) linking it to a project-service
  project -- project-service's `LedgerRecorder` seam calls this on every recorded
  spend, so a project's outflows are traceable in the public ledger too, not just
  in project-service's own record. No update or delete route exists for ledger
  entries, ever; corrections are new compensating entries.
- `GET /budget/ledger` -- public ledger listing, optional `?category_id=`/`?project_id=` filters.
- `POST /budget/reconcile` (DP-055) -- sums outflow ledger entries per category
  against `allocated_amount` and returns the discrepancies; an injected
  `AlertEmitter` (no-op by default) is called once per category with a non-zero
  discrepancy, standing in for the not-yet-implemented audit-service.

State is in-memory only (no database yet), encapsulated behind a store factory
so each test gets a clean instance.
