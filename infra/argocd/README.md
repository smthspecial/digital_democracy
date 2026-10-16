# `infra/argocd`

GitOps entry points for this cluster. Backend promotion uses the coordinated
procedure in [the release runbook](../release/README.md). Automatic backend
sync is disabled to prevent a mixed ADR-041 signing rollout; observability
continues to reconcile automatically.

| File | ArgoCD kind | Deploys |
|---|---|---|
| `applicationset.yaml` | `ApplicationSet` | The Go and TypeScript runtimes from `infra/helm/apps/*.yaml`, each rendered through `infra/helm/service` into its own namespace. Promotion is manual and migration-gated. |
| `observability.yaml` | `Application` | The current-stage observability slice (ADR-026, ARCH-025 §2): the upstream `kube-prometheus-stack` chart (Prometheus + Grafana + Alertmanager) into the `monitoring` namespace. One `Application`, not an `ApplicationSet`, because it's one specific third-party chart, not N near-identical services. |

Observability uses `syncPolicy.automated: { prune: true, selfHeal: true }`.
The backend ApplicationSet uses `CreateNamespace=true` with manual sync.
Pin its reviewed release revision and digest values before any sync; current
development tags are not a production release. Restore automatic reconciliation
only after a reviewed coordinator can enforce migrations and signer readiness.

## Bootstrapping

These are the resources ArgoCD itself reconciles, not how ArgoCD gets
installed. On a fresh k3s cluster (ARCH-025 §1): install ArgoCD, then
`kubectl apply -f infra/argocd/applicationset.yaml -f infra/argocd/observability.yaml`
once, in the `argocd` namespace, to register both. Everything after that
is a reviewed git revision followed by the required release gates.

`observability.yaml` also needs one one-time manual Secret before it will
report healthy -- Grafana's admin credentials aren't in git (see the
comment in that file for why: the External Secrets Operator + vault path
in ARCH-006 §9 is target state, not deployed at this build stage):

```bash
kubectl create namespace monitoring
kubectl create secret generic grafana-admin-credentials \
  -n monitoring \
  --from-literal=admin-user=admin \
  --from-literal=admin-password='<generate one, do not commit it>'
```

## Accessing Grafana

No public ingress for this stack yet -- ADR-026's slice is metrics/
dashboards/alerting for the team running the cluster, not a citizen-facing
surface, and ARCH-025 doesn't route it through the `dd-gateway` Gateway
API path the services use. For this stage, reach it with a port-forward:

```bash
kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80
```

Then open `http://localhost:3000` and sign in with the `grafana-admin-credentials`
Secret above. Prometheus and Alertmanager are reachable the same way if
needed directly (`svc/kube-prometheus-stack-prometheus` on port `9090`,
`svc/kube-prometheus-stack-alertmanager` on port `9093`), though most
day-to-day use is through Grafana's dashboards.

What you'll actually see today: cluster/node/pod-level signals only (is a
service up, is it restarting, is it CPU/memory-throttled) -- no
service in this repo exposes an application-level `/metrics` endpoint yet
(ARCH-025 §2), so there are no request-level SLI dashboards (latency,
error rate) until that instrumentation lands as separate follow-on work.
