# governance-role-service

TypeScript (ADR-019). Manages time-limited governance roles and
multi-approval coordination for critical actions. Spec:
[`.spec/technical/services/srv-011.md`](../../../.spec/technical/services/srv-011.md).
Route prefix `/governance-roles` behind the gateway (ARCH-006). Runs on
port 8080 in-container / 4009 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/governance-role-service dev    # local dev server (tsx watch)
pnpm --filter @dd/governance-role-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
