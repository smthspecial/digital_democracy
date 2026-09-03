---
id: ARCH-025
type: arch
title: "Current-stage infrastructure: k3s, observability slice, and local dev"
status: active
created: 2026-09-03
---

## Overview

Concrete implementation of ADR-026, sitting alongside `infra/helm`, `infra/argocd`, and `infra/terraform` (already scaffolded — this document describes what runs on top of that scaffolding today, not a rewrite of it). Where ARCH-006 describes the multi-region target topology, this document describes the single-cluster, no-cloud-vendor stage that precedes it.

---

## 1. Cluster: k3s

One self-hosted k3s node (or a small multi-node cluster, once there's a reason to need one — see ADR-026's maturity ladder) is the whole "cloud." Install with the upstream installer (`curl -sfL https://get.k3s.io | sh -`) on any Linux host — no cloud account, no Terraform run, matching ADR-026's "no paid vendor" decision for this phase. k3s bundles two things `infra/helm/service` already assumes exist:

- **Traefik**, satisfying the `HTTPRoute`/Gateway API expectation `infra/helm/service/templates/httproute.yaml` already has (it attaches to a Gateway named `dd-gateway`). Gateway API CRDs are not part of core Kubernetes and must be installed once (`kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml`), then a `GatewayClass`/`Gateway` named `dd-gateway` pointed at Traefik's controller (`traefik.io/gateway-controller`) — no separate Envoy Gateway/Kong install needed for this stage (ARCH-006 §2 names those as target-state options once traffic volume justifies a dedicated edge proxy). k3s's bundled Traefik ships its Gateway API provider disabled, so it needs one `HelmChartConfig` flip to turn on first. Every `HTTPRoute`'s `parentRef` is unqualified, which Gateway API resolves to the route's own namespace, and `infra/argocd/applicationset.yaml` gives every service its own namespace — so `dd-gateway` is applied once per service namespace, not once cluster-wide (`infra/k3s/README.md`, `infra/k3s/gateway.yaml`).
- **local-path-provisioner**, giving every service's future Postgres (ARCH-023/ADR-015's per-service database, once a service actually connects to one — no service does yet) a working `StorageClass` with zero extra setup.

Deploy the existing chart set exactly as `infra/argocd/applicationset.yaml` already describes: point ArgoCD at this cluster, and every `infra/helm/values/*.yaml` becomes a running service, self-healing via `selfHeal: true`.

---

## 2. Observability: kube-prometheus-stack

Deployed the same way every backend service is — one more Helm release, one more ArgoCD `Application` (`infra/argocd/observability.yaml` per §4) — not a bespoke installation. `kube-prometheus-stack` (Prometheus Community, Apache-2.0) bundles Prometheus, Grafana, Alertmanager, and the `ServiceMonitor`/`PodMonitor` CRDs Prometheus uses for scrape-target discovery, plus a set of default Kubernetes-infrastructure dashboards (node/pod resource usage, etc.) that are useful immediately, before any service exposes its own metrics.

**Explicitly deferred, per ADR-026**: application-level `/metrics` instrumentation (a `prom-client`/`promhttp`-style endpoint per service) — no service in this repo exposes one today, and wiring 18 services for it is separate follow-on work, not part of this pass. Until that lands, this stack observes cluster/node/pod health (is a service up, is it restarting, is it CPU/memory-throttled) but not yet request-level SLIs (ARCH-008 §2's latency/error-rate targets need that instrumentation first). Logs (Loki) and traces (OpenTelemetry collector + a tracing backend) are deferred the same way — ARCH-008's target stack, not implemented in this phase.

---

## 3. Fault tolerance additions to `infra/helm/service`

Two gaps against ADR-026's "self-healing" goal, closed in this pass:

- **`PodDisruptionBudget`** (new template, `templates/poddisruptionbudget.yaml`) — without one, a node drain (a k3s upgrade, a voluntary node cordon) can evict every replica of a service at once even with `replicaCount: 2`. `minAvailable: 1` by default, matching every service's existing `replicaCount: 2`/`autoscaling.minReplicas: 2` baseline (leaves at least one pod up during any single voluntary disruption).
- **`infra/helm/values/iam-service.yaml`** — SRV-018 (ADR-025/ARCH-024) was built after this Helm scaffolding existed and was missing from `infra/helm/values/`, so the ArgoCD `ApplicationSet` (which iterates that directory) never deployed it. Added, following the exact shape every other service's values file already has.

---

## 4. Local development: docker-compose

k3s is the right target for "a real, self-healing deployment," but it's the wrong tool for the fastest local inner loop — a docker-compose file at the repo root (`docker-compose.yml`, still absent before this pass) boots the currently-implemented services plus their real dependencies (NATS JetStream, matching every service's already-real `AuditEmitter` seam) directly via `docker compose up`, no cluster required. One shared local Postgres *server* (not one cluster per service — ADR-015's database-per-service boundary is a production topology decision about isolation and independent scaling, not a constraint on how many Postgres *processes* a laptop needs to run; compose gives each service its own *database* on that one shared server, keeping the schema/RLS boundary from ARCH-023 intact without needing 18 separate containers for local dev) rounds this out once a service actually connects to Postgres (none do yet — this is forward-compatible scaffolding, matching the pattern `infra/helm/values/*.yaml` already sets for services with no real dependencies wired up yet).

---

## Consequences

Every piece here is additive to what `infra/helm`/`infra/argocd` already had — no existing template, values file, or ArgoCD resource changes shape, only two new template files, one new values file, one new ArgoCD `Application`, one new root-level compose file, and a documented k3s bootstrap path. Moving up ADR-026's maturity ladder later (multi-node k3s, then ADR-017's multi-region cloud) reuses every one of these artifacts rather than replacing them.
