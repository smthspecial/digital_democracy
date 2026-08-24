# civic-duty-service

TypeScript (ADR-019). Owns randomized civic-duty assignment generation and
rotation. Spec: [`.spec/technical/services/srv-009.md`](../../../.spec/technical/services/srv-009.md).
Route prefix `/civic-duty` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4008 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/civic-duty-service dev    # local dev server (tsx watch)
pnpm --filter @dd/civic-duty-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
