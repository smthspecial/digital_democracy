# notification-service

TypeScript (ADR-019). Owns multi-channel (email, push, in-app) notification
dispatch. Spec: [`.spec/technical/services/srv-015.md`](../../../.spec/technical/services/srv-015.md).
Route prefix `/notifications` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4012 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/notification-service dev    # local dev server (tsx watch)
pnpm --filter @dd/notification-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
