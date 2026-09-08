# api-ts — one TypeScript app, thirteen services (ADR-027)

The I/O-bound backend shell: **identity, jurisdiction, problem, proposal,
competency, deliberation, budget, civic-duty, governance-role, project,
reputation, notification, ai-synthesis** (SRV-001…007, SRV-009, SRV-011,
SRV-013…016, SRV-018). One package, one process (`:4000`), one database
(`api_ts`, ADR-028).

> **Shell status.** Routing skeleton only — every service prefix answers
> `501 not_implemented` with its spec id until the real implementation lands.
> Zero dependencies (`node:http` only) so the shell builds, tests, and runs
> anywhere Node 20+ exists with no install step.

## Run

```bash
cd apps/api-ts
node src/index.js            # PORT=4000 by default
npm test 2>/dev/null; node --test test/
```

`GET /healthz`, `GET /readyz`. Contracts per service will live alongside
their implementations (ADR-021 `openapi.yaml` per service, future
`src/<service>/`).
