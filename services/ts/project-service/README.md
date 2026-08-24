# project-service

TypeScript (ADR-019). Owns approved-project implementation tracking and
milestone reporting. Spec: [`.spec/technical/services/srv-013.md`](../../../.spec/technical/services/srv-013.md).
Route prefix `/projects` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4010 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/project-service dev    # local dev server (tsx watch)
pnpm --filter @dd/project-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
