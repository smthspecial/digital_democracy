# k3s cluster bootstrap

Concrete steps for ADR-026 / ARCH-025 §1: one self-hosted k3s node, no
cloud vendor, running the chart set already scaffolded in `infra/helm`
and `infra/argocd`. Run these in order on a fresh Linux host.

## 1. Install k3s

```bash
curl -sfL https://get.k3s.io | sh -

# bundled kubectl works immediately
sudo k3s kubectl get nodes
```

k3s writes its kubeconfig to `/etc/rancher/k3s/k3s.yaml`, root-owned and
`0600`. Point a normal `kubectl` at the same cluster instead of typing
`k3s kubectl` every time:

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$(id -u):$(id -g)" ~/.kube/config

kubectl get nodes   # same result, no sudo, no k3s prefix
```

## 2. Gateway API CRDs

Not part of core Kubernetes -- `infra/helm/service/templates/httproute.yaml`'s
`HTTPRoute` needs these installed once, pinned to a specific release:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.1.0/standard-install.yaml
```

## 3. GatewayClass + Gateway (`dd-gateway`)

k3s's bundled Traefik has a Gateway API provider, but it ships disabled.
Turn it on via k3s's `HelmChartConfig` mechanism (a normal namespaced
resource -- `kubectl apply` reaches it the same as any other manifest,
no node filesystem access needed):

```bash
kubectl apply -f - <<'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    providers:
      kubernetesGateway:
        enabled: true
EOF
```

Then create the `GatewayClass`/`Gateway` named `dd-gateway` that every
service's `HTTPRoute` already expects (`infra/k3s/gateway.yaml`).
Traefik's Gateway API controller name is `traefik.io/gateway-controller`
(confirmed against Traefik's own docs and the k3s Helm chart behavior,
not guessed):

```bash
kubectl apply -f infra/k3s/gateway.yaml -n default

# confirm the GatewayClass reached Accepted (may take ~30s after step 3's
# HelmChartConfig lands)
kubectl get gatewayclass dd-gateway
```

`gateway.yaml`'s comments explain why: Gateway API resolves an
unqualified `parentRef` (which is what `httproute.yaml` uses) to the
*local* namespace of the route, and `infra/argocd/applicationset.yaml`
gives every service its own namespace. So `dd-gateway` needs to exist in
every service namespace, not just `default` -- step 4 covers this once
those namespaces exist.

## 4. ArgoCD

```bash
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/install.yaml

kubectl -n argocd wait --for=condition=available --timeout=300s deployment/argocd-server
```

Deploy every service (`infra/argocd/applicationset.yaml` iterates
`infra/helm/values/*.yaml`, one Argo `Application` each):

```bash
kubectl apply -f infra/argocd/applicationset.yaml
```

Observability (`kube-prometheus-stack`, ARCH-025 §2) deploys the same
way, from `infra/argocd/observability.yaml`:

```bash
kubectl apply -f infra/argocd/observability.yaml
```

Once ArgoCD's sync creates each service's namespace (`CreateNamespace=true`
in the `ApplicationSet`), finish step 3 by putting `dd-gateway` in every
one of them so each service's `HTTPRoute` actually attaches:

```bash
for ns in $(ls infra/helm/values/*.yaml | xargs -n1 basename -s .yaml); do
  kubectl apply -n "$ns" -f infra/k3s/gateway.yaml
done
```

## 5. What you get

Single-node k3s, self-healing via k3s pod rescheduling + `HorizontalPodAutoscaler`
+ `PodDisruptionBudget` (`infra/helm/service`) + ArgoCD `selfHeal: true`,
plus metrics/dashboards/alerting -- this is the **first rung** of
ADR-026's maturity ladder (single-node k3s, no cloud vendor). Not
included, deliberately: multi-node HA control plane, service-mesh
mTLS, and multi-region -- see ARCH-025 for what's deferred and why, and
ARCH-006 for the eventual multi-region target this stage is not yet
building toward.
