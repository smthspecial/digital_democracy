# jurisdiction-service

TypeScript (ADR-019). Owns jurisdiction and scope-of-impact definitions
and residency-based eligibility checks. Spec: [`.spec/technical/services/srv-002.md`](../../../.spec/technical/services/srv-002.md).
Route prefix `/jurisdiction` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4002 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/jurisdiction-service dev    # local dev server (tsx watch)
pnpm --filter @dd/jurisdiction-service test   # vitest
```

## Implemented

Besides the health contract (`/healthz`, `/readyz`):

- `POST /jurisdiction/jurisdictions` -- create a jurisdiction (nests via `parent_id`).
- `GET /jurisdiction/jurisdictions/:id/tree` -- the jurisdiction and all descendants, nested.
- `POST /jurisdiction/jurisdictions/:id/scope-level` -- change `scope_level`; gated by an
  injected `ApprovalGate` (DP-035, 403 when not approved; fake defaults to always-approved).
- `POST /jurisdiction/residencies` -- record a residency period.
- `POST /jurisdiction/memberships` -- record a citizen's membership in a jurisdiction; unique
  on `(citizen_id, jurisdiction_id)`, but a citizen may hold simultaneous memberships across
  nested jurisdictions.
- `GET /jurisdiction/memberships?citizen_id=` -- list a citizen's memberships.
- `GET /jurisdiction/eligibility?citizen_id=&scope_jurisdiction_id=&min_residency_days=` --
  the sync eligibility check consumed by voting-service at token-issuance time (DP-025).
  Eligible when the citizen holds both a membership and a sufficiently long current residency
  in `scope_jurisdiction_id` or in one of its descendants (same jurisdiction for both).
- `GET /jurisdiction/residency/verify?citizen_id=&jurisdiction_id=&at=` -- whether the citizen
  had current residency there at the given instant (defaults to now).

All state is in-memory (`src/store.ts`), reset per process. `scope_level` changes and
jurisdiction creation emit to `audit.append` (DP-036) via an injected `AuditEmitter`
(no-op by default). See `src/deps.ts` for how these seams are wired and overridden in tests.
