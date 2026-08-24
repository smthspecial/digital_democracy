# jurisdiction-service

TypeScript (ADR-019). Owns jurisdiction and scope-of-impact definitions
and residency-based eligibility checks. Spec: [`.spec/technical/services/srv-002.md`](../../../.spec/technical/services/srv-002.md).
Route prefix `/jurisdiction` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4002 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/jurisdiction-service dev    # local dev server (tsx watch)
pnpm --filter @dd/jurisdiction-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
