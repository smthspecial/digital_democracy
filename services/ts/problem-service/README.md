# problem-service

TypeScript (ADR-019). Owns problem registry submissions and
endorsement-threshold tracking. Spec: [`.spec/technical/services/srv-003.md`](../../../.spec/technical/services/srv-003.md).
Route prefix `/problems` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4003 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/problem-service dev    # local dev server (tsx watch)
pnpm --filter @dd/problem-service test   # vitest
```

## Implemented

Health contract (`/healthz`, `/readyz`) plus the problem registry endpoints:

- `POST /problems` -- submit a problem (DP-003, FR-015). Body:
  `{ citizen_id, title, description, affected_area, candidate_scope }`.
  Starts in `status: "open"` and is publicly readable immediately (FR-016).
- `GET /problems` / `GET /problems/:id` -- public reads.
- `POST /problems/:id/support` -- endorse a problem (DP-004, FR-016). Body:
  `{ citizen_id }`. One endorsement per citizen per problem (409 on repeat).
  Returns the updated `support_count` and, on success, notifies an injected
  `ThresholdChecker` (stands in for the DP-028 cross-service check against
  proposal-service's `support_threshold`, not implemented here).
- `POST /problems/:id/status` -- forward-only transition
  `open -> proposing -> closed`; any skip or backward move is rejected with
  409.

State is in-memory only, behind a store abstraction (`src/store.ts`) so a
real persistence layer can replace it later without changing callers.
Audit events (DP-036) on creation and status change, and the DP-028
threshold check, are modeled as injectable collaborator interfaces
(`src/collaborators.ts`) with no-op defaults. `AuditEmitter` has a real
queue-backed implementation, `createNatsAuditEmitter` (ADR-023): when
`NATS_URL` is set it publishes to the `audit.append` JetStream stream
instead of doing nothing (`problem.created`/`problem.status_changed` have
no dedicated TBL-034 bucket, so both map to `system_update`, with the
original local event name folded into the payload's `event_type` field).
`ThresholdChecker` remains no-op-only -- see ARCH-012's status notes for
why that one stays deliberately unbuilt (DP-028's threshold source
conflicts with proposal-service's actual support_count mechanism).
