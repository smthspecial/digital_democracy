# proposal-service

TypeScript (ADR-019). Owns proposal lifecycle: drafting, constraints,
budget attachment, scope assignment, and advancement to voting. Spec:
[`.spec/technical/services/srv-004.md`](../../../.spec/technical/services/srv-004.md).
Route prefix `/proposals` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4004 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/proposal-service dev    # local dev server (tsx watch)
pnpm --filter @dd/proposal-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
