# api-go — one Go app, four services (ADR-027)

The concurrency/crypto-critical backend: **voting** (SRV-008), **delegation**
(SRV-010), **audit** (SRV-012), **auth** (SRV-017). One module, one binary
(`:5000`), one database (`api_go`, ADR-028).

- Each service keeps its package boundary (`internal/<service>`), store, and
  route prefix (`/voting`, `/delegation`, `/audit`, `/auth`), so the four can
  be split back into independent deployments without re-cutting domain code.
- HTTP is stdlib `net/http` (ARCH-009, ADR-021). Contracts: `openapi/`.
- Events flow over NATS JetStream when `NATS_URL` is set (ADR-023) via the
  shared `packages/go/eventbus` client — one process-wide connection for all
  emitters plus the `audit.append` durable ordered consumer.
- Persistence is sqlc-generated repositories (`internal/sqlc/`, ADR-029) over
  `db/migrations/0001_init` when `DATABASE_URL` is set (migrated
  automatically at boot); otherwise the in-memory stores. `go test` never
  needs Postgres or NATS (both suites skip without them).

## Run

```bash
cd apps/api-go
go run .                                   # :5000, in-memory, seams stubbed
DATABASE_URL=postgres://dd:dd@localhost:5432/api_go NATS_URL=nats://localhost:4222 go run .
go test ./... && go vet ./... && go build ./...
sqlc generate                              # after touching db/queries or the migration
TEST_DATABASE_URL=postgres://dd:dd@localhost:5432/api_go go test ./...   # incl. Postgres backends
```

Seams default hermetic (ARCH-009) and become real via env — see
`.env.example`: `COMPETENCY_SERVICE_URL`, `IDENTITY_SERVICE_URL`,
`NOTIFICATION_SERVICE_URL`, `AUDIT_SERVICE_URL` (HTTP fallback when NATS is
down/unset), `DELEGATION_SERVICE_URL` (external override; in-process
resolution is direct-vote until sessions carry a domain).

## Scope notes (user-story coverage)

- Voting evaluates `method` + `threshold_rule` at tally (US-032) and quorum
  at certification (US-027/DP-027); cooling-off gates opening (US-034);
  blind-token separation + presence-only verification (US-002).
- Eligibility computation (residency/jurisdiction, US-031) and the voting
  package assembly (US-033) belong to jurisdiction-/proposal-service: this app
  issues tokens for caller-supplied eligible citizens and serves one
  competing-proposal option per vote option.
- Delegation is opt-in, per-domain, public, revocable, auto-expiring
  (US-043/US-044); delegates are competency-checked over the seam (fails
  closed in production).
- Audit is append-only, hash-chained, publicly readable (US-047/US-051);
  constitutional review blocks (US-045); the DP-043 delayed-execution gate
  releases only on full approvals + elapsed delay + visibility (US-048).
- Auth gates sessions on identity status and tiers every request (US-001
  support side, ADR-014).
