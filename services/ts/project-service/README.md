# project-service

TypeScript (ADR-019). Owns approved-project implementation tracking and
milestone reporting. Spec: [`.spec/technical/services/srv-013.md`](../../../.spec/technical/services/srv-013.md).
Route prefix `/projects` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4010 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/project-service dev    # local dev server (tsx watch)
pnpm --filter @dd/project-service test   # vitest
```

## Implemented

Besides the health contract (`/healthz`, `/readyz`), the service tracks
approved-proposal implementation as public projects (SRV-013):

- `POST /projects` -- creates a project (`status=active`), its milestones,
  and an `outcome_evaluation` row (DP-018/TBL-029/030/031 instantiation).
- `POST /projects/:id/milestones/:milestoneId/complete` -- reports milestone
  completion (DP-018); completing the last incomplete milestone also flips
  the project to `status=completed`.
- `POST /projects/:id/budget-spent` -- records a ledger outflow reconciled
  against the project by budget-service (modeled here as an explicit write
  since budget-service is a separate process).
- `POST /projects/outcome-evaluations/sweep` -- daily cron entry point
  (DP-053): requests an outcome-evaluation assignment for each completed
  project once the configured evaluation delay (default 180 days) has
  passed, at most once per project.
- `POST /projects/outcome-evaluations/:id/submit` -- records the measured
  outcome for a project (DP-022); both promised and measured outcome become
  publicly readable once submitted.
- `GET /projects`, `GET /projects/:id`, `GET /projects/:id/milestones` --
  public reads; no auth required (contractor and milestone data are always
  public per FR-047).

State is in-memory only (`src/store.ts`), behind a store factory so a real
persistence layer can replace it later without changing callers. Calls to
audit-service and civic-duty-service (which don't exist yet in this repo)
are modeled as injectable seams (`src/integrations.ts`) with no-op defaults.
