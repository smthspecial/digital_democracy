# problem-service

TypeScript (ADR-019). Owns problem registry submissions and
endorsement-threshold tracking. Spec: [`.spec/technical/services/srv-003.md`](../../../.spec/technical/services/srv-003.md).
Route prefix `/problems` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4003 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/problem-service dev    # local dev server (tsx watch)
pnpm --filter @dd/problem-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
