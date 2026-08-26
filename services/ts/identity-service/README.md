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
  multi-approval workflow (`403` without approval); revoke covers only this
  service's boundary of DP-042 (status flip + audit emit), not the
  cross-service cascade.
- `POST /identity/duplicates/scan` -- runs the DP-024/DP-056 duplicate
  detector (exact `legal_identity_hash` matches plus an injectable
  `DuplicateSignal` heuristic) across all citizens.

Every status change is emitted through an injectable `AuditEmitter`
(DP-036), defaulting to a no-op. Persistence is in-memory only, behind a
`Store` abstraction.
