# reputation-service

TypeScript (ADR-019). Owns participation reputation scoring, tracked
separately from voting weight. Spec: [`.spec/technical/services/srv-014.md`](../../../.spec/technical/services/srv-014.md).
Route prefix `/reputation` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4011 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/reputation-service dev    # local dev server (tsx watch)
pnpm --filter @dd/reputation-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
