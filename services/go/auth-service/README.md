# auth-service

Go (ADR-019) — SRV-017: Owns session lifecycle, MFA factor management,
and step-up authentication used by every other service. Spec: [`.spec/technical/services/srv-017.md`](../../../.spec/technical/services/srv-017.md).
Route prefix `/auth` behind the gateway (ARCH-006). Runs on port 8080
in-container / 5004 in local dev (see root `README.md`). Stdlib only
(`net/http`) — no third-party dependencies, so `go build`/`go test` need
nothing beyond the Go toolchain itself.

```bash
go run .     # local dev server
go test ./... # unit tests
```

## Implemented

Beyond the health contract (`/healthz`, `/readyz`), this service implements
session lifecycle, MFA factor enrollment, step-up authentication, and anomaly
detection (DP-059, DP-060, DP-061, DP-067), entirely in-memory behind
repository-style store methods (`store.go`) so a real persistence layer can
replace them later without changing callers.

- `POST /auth/login` — issues a T1 session; reports whether step-up is required
  and which factor types are available.
- `POST /auth/logout` — revokes a session and zeroes its refresh token hash.
- `POST /auth/refresh` — rotates the refresh token; detects device/subnet
  mismatch and refresh-token reuse as anomalies (suspends the session);
  downgrades the tier to T1 if the last MFA is more than 12h old.
- `POST /auth/factors` — enrolls a TOTP, passkey, or facial biometric factor
  and upgrades the session's assurance tier (T2 for TOTP, T3 for passkey/facial).
- `POST /auth/stepup` — verifies a step-up MFA proof and raises the session's
  assurance tier; locks the session after 5 failures within 10 minutes
  (anomaly_reason=mfa_brute_force).
- `POST /auth/internal/validate` — hash-lookup access token validation, used
  by every other service.
- `POST /auth/internal/revoke-all/{citizenID}` — forced revocation, consumed
  by identity-service (DP-042/DP-035).
- `POST /auth/internal/purge-sessions` — DP-067 cron: deletes naturally
  expired, never-revoked sessions past their retention grace window.

Real cryptography (`crypto.go`, stdlib only): RFC 6238 TOTP (HMAC-SHA1),
ECDSA P-256 passkey challenge/response, facial-embedding cosine similarity
with a mandatory liveness flag, AES-256-GCM encryption at rest for secrets/
embeddings, and sha256-hashed access/refresh tokens (plaintext is never
persisted).

There is no live identity-service, KMS, or audit-service integration yet —
each is modeled as a small injectable seam (see comments at `AuditEmitter` in
`service.go` and the encryption-key comment in `crypto.go`), or accepted as
explicit, caller-trusted request fields (e.g. `citizen_status`,
`credential_valid` on `/auth/login`) documented in `handlers.go`.
