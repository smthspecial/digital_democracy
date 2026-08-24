# Digital Democracy — monorepo

Project specification lives in [`.spec/`](.spec/AGENTS.md) (backlog, requirements, ADRs,
architecture, services, database, auth) and the founding concept documents in
[`white_paper/`](white_paper/) (also summarized under `.spec/concept/`). This repo is the
code that implements that spec.

## Layout

```
apps/
  web/                 Next.js citizen-facing web client (ADR-022)
  mobile/              Expo (React Native) mobile client (ADR-022)
services/
  ts/                  13 TypeScript services -- CRUD/orchestration (ADR-019)
  go/                  4 Go services -- concurrency/crypto-critical path (ADR-019)
packages/
  tsconfig/            shared base tsconfig for every TS package
  eslint-config/       shared flat ESLint config
  api-client/          generated, typed API client shared by web + mobile (ADR-021)
infra/
  helm/service/        one generic Helm chart, parameterized per service
  helm/values/         one small values file per service (deploy target)
  argocd/              ArgoCD ApplicationSet templating over helm/values/*
  terraform/           cluster/network IaC skeleton (ARCH-006)
```

## Services

| Service | Lang | Port (local) | Route prefix | Spec |
|---|---|---|---|---|
| identity-service | TS | 4001 | `/identity` | SRV-001 |
| jurisdiction-service | TS | 4002 | `/jurisdiction` | SRV-002 |
| problem-service | TS | 4003 | `/problems` | SRV-003 |
| proposal-service | TS | 4004 | `/proposals` | SRV-004 |
| competency-service | TS | 4005 | `/competency` | SRV-005 |
| deliberation-service | TS | 4006 | `/deliberation` | SRV-006 |
| budget-service | TS | 4007 | `/budget` | SRV-007 |
| voting-service | **Go** | 5001 | `/voting` | SRV-008 |
| civic-duty-service | TS | 4008 | `/civic-duty` | SRV-009 |
| delegation-service | **Go** | 5002 | `/delegation` | SRV-010 |
| governance-role-service | TS | 4009 | `/governance-roles` | SRV-011 |
| audit-service | **Go** | 5003 | `/audit` | SRV-012 |
| project-service | TS | 4010 | `/projects` | SRV-013 |
| reputation-service | TS | 4011 | `/reputation` | SRV-014 |
| notification-service | TS | 4012 | `/notifications` | SRV-015 |
| ai-synthesis-service | TS | 4013 | `/ai-synthesis` | SRV-016 |
| auth-service | **Go** | 5004 | `/auth` | SRV-017 |

Every service exposes `GET /healthz` (liveness) and `GET /readyz` (readiness), and documents
its API in its own `openapi.yaml`. See ADR-019 (language split), ADR-020 (monorepo tooling),
ADR-021 (HTTP/JSON + OpenAPI now, gRPC later), ADR-022 (web/mobile).

## Prerequisites

- Node.js >= 20, [pnpm](https://pnpm.io) >= 9
- Go >= 1.22 (for `services/go/*` — not required to work on the TS side)
- Docker (for building service images)
- For infra work: `helm`, `terraform`, `kubectl` (not required for application code)

## Getting started

```bash
pnpm install        # installs every TS workspace package
make dev            # runs all TS services + web via turbo (Go services: see below)
```

Go services run independently of the pnpm/turbo dev loop:

```bash
cd services/go/voting-service && go run .
```

## Common commands

| Command | Does |
|---|---|
| `make build` / `make lint` / `make typecheck` / `make test` | TS workspace, via Turborepo (only affected packages re-run) |
| `make go-build` / `make go-test` / `make go-vet` | all 4 Go services |
| `make docker-build SERVICE=<name> LANG=<ts\|go>` | build one service's container image |

## Adding a service

1. Create `services/<ts|go>/<name>/` following an existing sibling service's structure.
2. Add its `openapi.yaml` and wire it into `packages/api-client`'s generation (`pnpm --filter @dd/api-client generate`).
3. Add `infra/helm/values/<name>.yaml` (copy a sibling, change `name`/`image`/`port`).
4. If Go: add the module path to `go.work`.
5. Record the service in `.spec/technical/services/` (see `.spec/AGENTS.md`) and update the table above.
