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
  api-go/              Go app: voting, delegation, audit, auth (ADR-019, ADR-027)
  api-ts/              TypeScript app: 13 CRUD/orchestration services (ADR-019, ADR-027)
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

One app per runtime (ADR-027), one database per app (ADR-028):

| App | Lang | Port (local) | Route prefixes | Spec |
|---|---|---|---|---|
| api-go (voting, delegation, audit, auth) | Go | 5000 | `/voting`, `/delegation`, `/audit`, `/auth` | SRV-008, SRV-010, SRV-012, SRV-017 |
| api-ts (13 services, shell) | TS | 4000 | `/identity`, `/jurisdiction`, `/problems`, `/proposals`, `/competency`, `/deliberation`, `/budget`, `/civic-duty`, `/governance-roles`, `/projects`, `/reputation`, `/notifications`, `/ai-synthesis` | SRV-001…007, SRV-009, SRV-011, SRV-013…016, SRV-018 |

Every app exposes `GET /healthz` (liveness) and `GET /readyz` (readiness).
api-go documents its API per service in `apps/api-go/openapi/`. See ADR-019
(language split), ADR-020 (monorepo tooling), ADR-021 (HTTP/JSON + OpenAPI
now, gRPC later), ADR-022 (web/mobile), ADR-027 (one app per runtime).

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

Go and TS run as standalone apps, outside the pnpm/turbo dev loop:

```bash
cd apps/api-go && go run .        # :5000 (in-memory; DATABASE_URL+NATS_URL to wire up)
cd apps/api-ts && node src/index.js  # :4000 (routing shell)
```

### Running everything together

One compose file runs the whole backend — both apps, real NATS JetStream,
and one Postgres per app (ADR-026, ADR-027, ADR-028, ARCH-025 §4):

```bash
podman compose up --build   # or: docker compose up --build
```

This is the fast local inner-loop alternative to the k3s target ARCH-025
describes — no cluster required. api-go migrates and connects to its
`api_go` database automatically (`DATABASE_URL`); api-ts serves its routing
shell against an empty `api_ts` database until its services land.

## Common commands

| Command | Does |
|---|---|
| `make build` / `make lint` / `make typecheck` / `make test` | TS workspace, via Turborepo (only affected packages re-run) |
| `make go-build` / `make go-test` / `make go-vet` | Go workspace (`apps/api-go`, `packages/go/eventbus`) |
| `make docker-build SERVICE=<api-go\|api-ts>` | build one app's container image |

## Adding a service

Services live inside their runtime's app (`apps/api-go/internal/<name>/`,
future `apps/api-ts/src/<name>/`), never as new top-level directories:

1. Add the package following a sibling service's structure (domain, store,
   service, handlers, router, tests).
2. Mount its routes in the app entrypoint; add its contract to
   `apps/api-go/openapi/` (ADR-021).
3. Add its tables to the app's database migration (one db per app, ADR-028)
   and its sqlc queries + repository if Go (ADR-029).
4. Record the service in `.spec/technical/services/` (see `.spec/AGENTS.md`)
   and update the table above.
