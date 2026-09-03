# delegation-service

Go (ADR-019) — Owns liquid-democracy delegation creation, revocation, and
chain resolution feeding the voting pipeline. Spec: [`.spec/technical/services/srv-010.md`](../../../.spec/technical/services/srv-010.md).
Route prefix `/delegation` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5002 in local dev (see root `README.md`). Stdlib only
(`net/http`) — no third-party dependencies, so `go build`/`go test` need
nothing beyond the Go toolchain itself.

```bash
go run .     # local dev server
go test ./... # unit tests
```

## Implemented

Health contract (`/healthz`, `/readyz`) plus the delegation business
endpoints (DP-014, DP-015, DP-041, DP-045), backed by an in-memory,
thread-safe store (`store.go`) behind repository-style methods so a real
persistence layer can replace it later without changing callers.

- `POST /delegation/delegations` — create a delegation (DP-014). Body:
  `{"delegator_id","delegate_id","domain_id","expires_at"}` (`expires_at` as
  RFC3339). Rejects self-delegation, a non-future `expires_at`, a delegate
  without active domain competency, and anything that would create a cycle
  in the active delegator→delegate graph for that domain (direct or
  transitive). Returns `201` with the created row.
- `DELETE /delegation/delegations/{id}` — revoke a delegation (DP-015).
  Body: `{"requesting_citizen_id"}`; only the original delegator may revoke.
  `200` with the updated row, `403` if the requester isn't the delegator,
  `404` for an unknown id, `409` if already revoked. The row is never
  deleted — `revoked_at` is set instead.
- `GET /delegation/delegations` — list delegations (FR-056: publicly
  visible, no auth gating). Optional `?delegator_id=&delegate_id=&domain_id=`
  filters. Returns `200 {"delegations": [...]}`.
- `POST /delegation/resolve` — resolve a delegation chain (DP-041), the
  internal endpoint voting-service calls at ballot-cast time. Body:
  `{"delegate_id","domain_id"}`. Returns `200 {"delegator_ids": [...]}`: the
  full set of citizens (direct and transitive) whose active delegation in
  that domain terminates at the given delegate, as of now.
- `POST /delegation/internal/expire` — expiry enforcement cron (DP-045).
  Sets `revoked_at` on every delegation whose `expires_at` has passed and
  isn't already revoked. Idempotent: a repeat call revokes 0. Returns
  `200 {"revoked_count": N}`.

All error responses are `{"error": "<message>"}`.

## Simplifications

Two upstream dependencies from SRV-010's spec aren't live services yet in
this codebase, so they're modeled as small injectable interfaces (wired in
`main.go`, defaults used in production for now):

- `CompetencyChecker` (`service.go`) — models the read from
  competency-service (delegate must hold active domain competency). Default
  allows every delegate.
- `AuditEmitter` (`service.go`) — models the async DP-036 audit-log append
  to audit-service on create/revoke/expiry. Default is a no-op; when
  `NATS_URL` is set, `natsAuditEmitter` (`nats.go`, ADR-023) publishes each
  `delegation.created`/`delegation.revoked`/`delegation.expired` event to
  the `audit.append` JetStream stream instead, mapped to TBL-034's generic
  `system_update` action_type since delegation events don't have a
  dedicated bucket of their own.
