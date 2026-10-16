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
  `db/migrations/` when `DATABASE_URL` is set (apply migrations in a separate
  job before startup); otherwise the in-memory stores. `go test` never
  needs Postgres or NATS (both suites skip without them).

## Run

```bash
cd apps/api-go
go run .                                   # :5000, in-memory, seams stubbed
# Configure restricted DATABASE_URL and signing keys using .env.example.
go run .
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

### Browser passkey checks (test harness only)

From the repository root, install Chromium with `pnpm exec playwright install
chromium` and run `pnpm test:passkeys`. The tests use actual browser WebAuthn APIs
and a virtual authenticator against the real auth router; no test gateway or
fake identity checker is compiled into the app. Set `TEST_DATABASE_URL` to a
disposable Postgres database for the persistent tier (it truncates auth tables).
Set `REQUIRE_DB_TESTS=1` to require that tier, as CI does. An existing local browser
can be selected with `PASSKEY_CHROMIUM_PATH`. See TP-015 for scope and limits.

Virtual-authenticator success does not replace a manual physical/platform-passkey
check or integration of the trusted identity-proofing and grant-delivery channel.

### Service coverage

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

## Security controls

Internal writes require nonce-bearing signed service calls (ADR-041). Citizen
ballot/delegation writes validate bearer sessions, enforce T3/T2 and ownership.
Token issuance fetches the verified jurisdiction roster; send `{}` or an `after`
cursor, never citizen IDs. Casting requires `proof` and a configured
`BALLOT_VERIFIER_URL`; absent cryptographic validation fails closed.

Persistent runtime credentials must be restricted. Apply migrations separately:
`MIGRATE_ONLY=1 MIGRATE_DATABASE_URL=... ./api-go`, then start with only the
restricted `DATABASE_URL` and a stable random `AUDIT_SIGNING_KEY`. The server
publishes the Ed25519 public key at `/audit/signing-key`. Legacy signatures are
not silently re-signed. See `testing/security/REMEDIATION.md` for deployment and
verification details.
