# identity-service

TypeScript (ADR-019). Owns civic identity records and identity
verification. Spec: [`.spec/technical/services/srv-001.md`](../../../.spec/technical/services/srv-001.md).
Route prefix `/identity` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4001 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/identity-service dev    # local dev server (tsx watch)
pnpm --filter @dd/identity-service test   # vitest
```

Requires a Postgres instance reachable via `DATABASE_URL` (see
`.env.example`); migrations under `migrations/` run automatically on
startup.

## Implemented

- `POST /citizens` -- DP-001, register civic identity (`status=pending`)
- `POST /verifications` -- DP-002, submit verification evidence; activates
  the citizen on approval and runs the DP-024 duplicate check
- `GET /citizens/:id` -- public record lookup
- `/healthz`, `/readyz`

FR-001 (single active identity per citizen) is enforced at the database
layer via a partial unique index on `legal_identity_hash`, so duplicate
registrations are rejected synchronously (`409`) rather than only caught by
DP-024's async pass.

## Not yet implemented

- DP-024's transport is a `LoggingEventPublisher` stub (`src/events.ts`),
  not a real Kafka producer (ARCH-006)
- DP-042 (identity revocation cascade) and DP-056 (weekly duplicate sweep)
- `src/verification-provider.ts` approves any non-empty evidence reference;
  it is the integration point for a real national ID / passport / gov
  credential verification system (ADR-003)
