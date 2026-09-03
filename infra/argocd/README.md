# `infra/argocd`

GitOps entry points for this cluster. ArgoCD watches this repo and
reconciles the cluster to match it (`selfHeal: true` everywhere in this
directory) -- there is no out-of-band `kubectl apply`/`helm install` path
for anything listed below.

| File | ArgoCD kind | Deploys |
|---|---|---|
| `applicationset.yaml` | `ApplicationSet` | Every backend service in this repo. Iterates `infra/helm/values/*.yaml`, rendering each through the generic chart at `infra/helm/service` (see its `README.md`) into its own namespace. Add a service by adding a values file -- nothing to register here. |
| `observability.yaml` | `Application` | The current-stage observability slice (ADR-026, ARCH-025 §2): the upstream `kube-prometheus-stack` chart (Prometheus + Grafana + Alertmanager) into the `monitoring` namespace. One `Application`, not an `ApplicationSet`, because it's one specific third-party chart, not N near-identical services. |

Both resources share the same self-healing posture: `syncPolicy.automated:
{ prune: true, selfHeal: true }` plus `CreateNamespace=true`, so a manual
`kubectl edit`/`kubectl delete` against anything they manage gets
reconciled back within one sync interval, per ADR-026's "self-healing
comes from ArgoCD" consequence.

## Bootstrapping

These are the resources ArgoCD itself reconciles, not how ArgoCD gets
installed. On a fresh k3s cluster (ARCH-025 §1): install ArgoCD, then
`kubectl apply -f infra/argocd/applicationset.yaml -f infra/argocd/observability.yaml`
once, in the `argocd` namespace, to register both. Everything after that
is a git commit.

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
