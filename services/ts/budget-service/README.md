# budget-service

TypeScript (ADR-019). Owns budget allocation votes and the public
spending ledger. Spec: [`.spec/technical/services/srv-007.md`](../../../.spec/technical/services/srv-007.md).
Route prefix `/budget` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4007 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/budget-service dev    # local dev server (tsx watch)
pnpm --filter @dd/budget-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
