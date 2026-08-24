# identity-service

TypeScript (ADR-019). Owns civic identity records and identity
verification. Spec: [`.spec/technical/services/srv-001.md`](../../../.spec/technical/services/srv-001.md).
Route prefix `/identity` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4001 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/identity-service dev    # local dev server (tsx watch)
pnpm --filter @dd/identity-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
(`DP-001`, `DP-002`, ...) as they're built.
