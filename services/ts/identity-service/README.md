# identity-service

TypeScript (ADR-019). Owns civic identity records and identity
verification. Spec: [`.spec/technical/services/srv-001.md`](../../../.spec/technical/services/srv-001.md).
Route prefix `/identity` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4001 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/identity-service dev    # local dev server (tsx watch)
pnpm --filter @dd/identity-service test   # vitest
```

## Implemented

Health contract (`/healthz`, `/readyz`) plus the civic identity lifecycle
(`DP-001`, `DP-002`, `DP-024`, `DP-042`, `DP-056`):

- `POST /identity/citizens` -- register a citizen (`status=pending`).
  Accepts `raw_legal_identifier` once, hashes it (HMAC-SHA256 keyed by a
  per-install pepper) into `legal_identity_hash`, and discards the raw
  value; rejects an exact duplicate hash with `409`.
- `GET /identity/citizens`, `GET /identity/citizens/:id` -- read.
- `POST /identity/citizens/:id/verifications` -- record a verification
  attempt (`evidence_ref` + `outcome: verified|rejected`); the real
  document/liveness pipeline is out of scope here, so the outcome is
  accepted as an explicit input. The first `verified` record activates the
  citizen.
- `POST /identity/citizens/:id/suspend`, `POST /identity/citizens/:id/revoke`
  -- both gated by an injectable `ApprovalGate` modeling the DP-023 -> DP-035
  multi-approval workflow (`403` without approval), both reject an illegal
  status transition with `409` (double-suspend, re-suspending a revoked
  citizen, or re-revoking an already-revoked one -- ARCH-010 EC-4), and both
  terminate the citizen's active sessions via an injectable `SessionRevoker`
  (DP-042's cascade into auth-service's `revoke_all_sessions`) so a
  suspension or revocation takes effect immediately rather than only once
  the session's own TTL lapses. `SessionRevoker` has a real HTTP-calling
  implementation (`createHttpSessionRevoker`, calling `POST
  /auth/internal/revoke-all/:citizenId`), wired in by `index.ts` whenever
  `AUTH_SERVICE_URL` is set, falling back to a no-op otherwise. `ApprovalGate`
  has a real HTTP-calling implementation (`createHttpApprovalGate`, calling
  `GET /governance-roles/actions/identity:{suspend|revoke}:{citizenId}/status`
  -- the action-type-scoped `action_ref` convention ARCH-010 §2 defines, so a
  suspend approval can never satisfy a revoke check on the same citizen),
  wired in by `index.ts` whenever `GOVERNANCE_ROLE_SERVICE_URL` is set,
  falling back to the permissive default otherwise, and failing closed (not
  approved) on any lookup failure. The rest of DP-042's cascade (delegations,
  assignments, tokens, governance roles) is owned by other services and out
  of scope here.
- `POST /identity/duplicates/scan` -- runs the DP-024/DP-056 duplicate
  detector (exact `legal_identity_hash` matches plus an injectable
  `DuplicateSignal` heuristic) across all citizens.

Every status change is emitted through an injectable `AuditEmitter`
(DP-036), defaulting to a no-op. `AuditEmitter` has a real queue-backed
implementation, `createNatsAuditEmitter` (ADR-023): when `NATS_URL` is set
it publishes to the `audit.append` JetStream stream (every citizen event --
registered, verified, activated, suspended, revoked -- maps to TBL-034's
`identity_event` action_type) instead of doing nothing. Persistence is
in-memory only, behind a `Store` abstraction.
