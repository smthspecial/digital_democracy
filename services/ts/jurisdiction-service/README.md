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
  injected `ApprovalGate` (DP-035, 403 when not approved; permissive default of always-approved).
  `ApprovalGate` has a real HTTP-calling implementation (`createHttpApprovalGate`, calling
  `GET /governance-roles/actions/jurisdiction:scope-level:{id}/status`), wired in by `index.ts`
  whenever `GOVERNANCE_ROLE_SERVICE_URL` is set, and failing closed (not approved) on any
  lookup failure (ARCH-011 EC-31).
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

All state is in-memory (`src/store.ts`), reset per process. Jurisdiction creation,
scope-level changes, residency creation, and membership creation all emit to
`audit.append` (DP-036) via an injected `AuditEmitter` (no-op by default). See
`src/deps.ts` for how these seams are wired and overridden in tests.
`AuditEmitter` has a real queue-backed implementation,
`createNatsAuditEmitter` (ADR-023): when `NATS_URL` is set it publishes to
the `audit.append` JetStream stream instead of doing nothing (every event
here maps to TBL-034's `admin_action`, with the original local event name
folded into the payload's `event_type` field since none of them have a more
specific TBL-034 bucket of their own).
