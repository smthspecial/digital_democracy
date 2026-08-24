# deliberation-service

TypeScript (ADR-019). Owns deliberation arguments and preference
declarations, and triggers AI-assisted synthesis. Spec:
[`.spec/technical/services/srv-006.md`](../../../.spec/technical/services/srv-006.md).
Route prefix `/deliberation` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4006 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/deliberation-service dev    # local dev server (tsx watch)
pnpm --filter @dd/deliberation-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
