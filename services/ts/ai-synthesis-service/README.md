# ai-synthesis-service

TypeScript (ADR-019). Owns AI-assisted deliberation synthesis; advisory
and non-authoritative only. Spec: [`.spec/technical/services/srv-016.md`](../../../.spec/technical/services/srv-016.md).
Route prefix `/ai-synthesis` behind the gateway (ARCH-006). Runs on port
8080 in-container / 4013 in local dev (see root `README.md`).

```bash
pnpm --filter @dd/ai-synthesis-service dev    # local dev server (tsx watch)
pnpm --filter @dd/ai-synthesis-service test   # vitest
```

Only the health contract (`/healthz`, `/readyz`) is implemented so far --
business endpoints are added alongside their data processes
as they're built (see .spec/technical/data-processes/ for this service's processes).
