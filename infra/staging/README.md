# Disposable staging fixture

Use a dedicated kubeconfig and cluster name; never rely on the current context.
`kind.yaml` disables the default CNI because live NetworkPolicy tests require an
enforcing CNI. Install the pinned Calico before qualifying workloads. The next
fixture uses the official kind 0.33.0 Kubernetes 1.36.4 image digest, within the
[Istio 1.30 support range](https://istio.io/latest/docs/releases/supported-releases/).
The official Helm index provided Istio 1.30.5 at qualification time; the 1.31.1
chart was unavailable. Gateway API 1.5.1 matches Istio 1.30's upgrade guidance.

`versions.json` records the intended fixture versions. Verify actual published
charts/manifests and their checksums before installation; version selection
alone is not live qualification. Install Gateway API CRDs before cert-manager
with Gateway API support enabled. Use the real Traefik controller from the k3s
baseline, including its mesh identity, rather than treating a kind default
network as production ingress evidence.

Example creation with rootless Podman (on a host supporting cgroup delegation):

```sh
systemd-run --user --scope -p Delegate=yes env KIND_EXPERIMENTAL_PROVIDER=podman \
  kind create cluster --name dd-security-staging \
  --config infra/staging/kind.yaml --kubeconfig /tmp/dd-security-staging.kubeconfig
```

The 2026-10-08 attempt booted Kubernetes 1.37.0 but failed networking when
kube-proxy could not allocate an fsnotify watcher. The host's inotify instance
limit was 128; this environment's no-new-privileges restriction prevented a
temporary limit change. No host limit was changed. The disposable cluster was
removed; [sanitized evidence](../../testing/production-readiness/staging-attempt.json)
is retained. CNI, mesh, ingress, certificate renewal and network isolation have
not passed live qualification. Retry on a suitable host or confirmed existing
staging cluster; do not disable the network controls to get a passing result.

Sources: [kind release image digests](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0),
[rootless kind](https://kind.sigs.k8s.io/docs/user/rootless/),
[Calico on kind](https://docs.tigera.io/calico/latest/getting-started/kubernetes/kind),
[cert-manager Gateway usage](https://cert-manager.io/docs/usage/gateway/),
[Istio 1.30 upgrade notes](https://istio.io/latest/news/releases/1.30.x/announcing-1.30/upgrade-notes/).
