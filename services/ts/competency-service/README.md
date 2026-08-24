# competency-service

TypeScript (ADR-019). Owns domain competency applications,
conflict-of-interest declarations, and competency challenges. Spec:
[`.spec/technical/services/srv-005.md`](../../../.spec/technical/services/srv-005.md).
Route prefix `/competency` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4005 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/competency-service dev    # local dev server (tsx watch)
pnpm --filter @dd/competency-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
